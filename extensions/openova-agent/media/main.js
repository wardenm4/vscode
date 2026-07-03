/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');

	let sessions = [];
	let active = null;
	let settings = { provider: 'ollama', model: '', effort: 'off' };
	let workspace = null;
	let running = false;
	let liveText = '';
	let liveMsgId = null;

	// ---- helpers ----
	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text !== undefined) { n.textContent = text; }
		return n;
	}

	// Minimal fenced-code renderer: text nodes + <pre> blocks, no innerHTML.
	function renderBody(container, text) {
		container.textContent = '';
		const parts = String(text).split(/```[\w-]*\n?/);
		for (let i = 0; i < parts.length; i++) {
			if (!parts[i]) { continue; }
			if (i % 2 === 1) {
				const pre = el('pre');
				pre.textContent = parts[i].replace(/\n$/, '');
				container.appendChild(pre);
			} else {
				container.appendChild(document.createTextNode(parts[i]));
			}
		}
	}

	function glyphFor(step) {
		if (step.status === 'running') {
			const s = el('span', 'spin');
			return s;
		}
		// allow-any-unicode-next-line
		return document.createTextNode(step.status === 'error' ? '✕' : step.kind === 'thought' ? '·' : '✓');
	}

	// ---- rendering ----
	function render() {
		app.textContent = '';
		const sess = sessions.find((s) => s.id === active);

		// header
		const head = el('div', 'head');
		const logo = document.createElement('img');
		logo.src = document.body.dataset.icon;
		head.appendChild(logo);
		head.appendChild(el('span', 'title', (sess && sess.title) || 'Openova Agent'));
		const plus = el('button', '', '+');
		plus.title = 'New chat';
		plus.onclick = () => vscode.postMessage({ type: 'newSession' });
		head.appendChild(plus);
		app.appendChild(head);

		// session chips
		const withMsgs = sessions.filter((s) => s.messages.length > 0 || s.id === active);
		if (withMsgs.length > 1) {
			const strip = el('div', 'sessions');
			for (const s of withMsgs) {
				const chip = el('span', 'chip' + (s.id === active ? ' active' : ''));
				chip.appendChild(document.createTextNode(s.title || 'New Chat'));
				// allow-any-unicode-next-line
				const x = el('span', 'x', ' ✕');
				x.onclick = (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'deleteSession', id: s.id });
				};
				chip.appendChild(x);
				chip.onclick = () => vscode.postMessage({ type: 'switchSession', id: s.id });
				strip.appendChild(chip);
			}
			app.appendChild(strip);
		}

		// transcript
		const msgs = el('div', 'msgs');
		if (!sess || sess.messages.length === 0) {
			const empty = el('div', 'empty');
			empty.textContent =
				'Ask Openova anything, or switch to Agent mode to build autonomously' +
				(workspace ? ' in ' + workspace : '') +
				'. The agent reads and writes workspace files and runs gated commands.';
			msgs.appendChild(empty);
		} else {
			for (const m of sess.messages) {
				const box = el('div', 'msg ' + m.role);
				box.appendChild(el('div', 'who', m.role === 'user' ? 'You' : 'Openova'));
				if (m.steps && m.steps.length) {
					const steps = el('div', 'steps');
					for (const st of m.steps) {
						steps.appendChild(renderStep(st));
					}
					box.appendChild(steps);
				}
				if (m.id === liveMsgId && liveText) {
					box.appendChild(el('div', 'live', liveText));
				}
				if (m.content) {
					const body = el('div', 'body');
					renderBody(body, m.content);
					box.appendChild(body);
				}
				msgs.appendChild(box);
			}
		}
		app.appendChild(msgs);

		// composer
		const composer = el('div', 'composer');
		const ta = document.createElement('textarea');
		ta.placeholder = running ? 'Running…' : 'Ask, or describe what to build…';
		ta.rows = 1;
		ta.onkeydown = (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				submit(ta);
			}
		};
		ta.oninput = () => {
			ta.style.height = 'auto';
			ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
		};
		composer.appendChild(ta);

		const bar = el('div', 'bar');
		const mode = document.createElement('select');
		for (const [v, label] of [['agent', 'Agent'], ['ask', 'Ask']]) {
			const o = document.createElement('option');
			o.value = v;
			o.textContent = label;
			mode.appendChild(o);
		}
		mode.value = state.mode;
		mode.onchange = () => {
			state.mode = mode.value;
			vscode.setState(state);
		};
		bar.appendChild(mode);

		const model = el('button', 'model', settings.provider + ' · ' + (settings.model || 'model?'));
		model.title = 'Change in Settings: openova.provider / openova.model';
		model.onclick = () => {
			const next = prompt('Model id for ' + settings.provider + ':', settings.model);
			if (next) { vscode.postMessage({ type: 'setSettings', patch: { model: next } }); }
		};
		bar.appendChild(model);

		const send = el('button', 'send' + (running ? ' stop' : ''), running ? 'Stop' : 'Send');
		send.onclick = () => {
			if (running) { vscode.postMessage({ type: 'abort', sessionId: active }); }
			else { submit(ta); }
		};
		bar.appendChild(send);
		composer.appendChild(bar);
		app.appendChild(composer);

		msgs.scrollTop = msgs.scrollHeight;
	}

	function renderStep(st) {
		const box = el('div', 'step ' + st.status + (st.kind === 'thought' ? ' thought' : ''));
		const row = el('div', 'row');
		const g = el('span', 'glyph');
		g.appendChild(glyphFor(st));
		row.appendChild(g);
		row.appendChild(el('span', 't', st.title));
		box.appendChild(row);
		if (st.detail) {
			const d = el('pre', 'detail');
			d.textContent = st.detail;
			d.style.display = 'none';
			row.onclick = () => {
				d.style.display = d.style.display === 'none' ? 'block' : 'none';
			};
			box.appendChild(d);
		}
		return box;
	}

	function submit(ta) {
		const text = ta.value.trim();
		if (!text || running) { return; }
		ta.value = '';
		vscode.postMessage({ type: 'send', sessionId: active, text, mode: state.mode });
	}

	// ---- state + host messages ----
	const state = vscode.getState() || { mode: 'agent' };

	window.addEventListener('message', (e) => {
		const m = e.data;
		switch (m.type) {
			case 'init':
				sessions = m.sessions;
				active = m.active;
				settings = m.settings;
				workspace = m.workspace;
				render();
				break;
			case 'sessions':
				sessions = m.sessions;
				active = m.active;
				render();
				break;
			case 'settings':
				settings = m.settings;
				render();
				break;
			case 'running':
				running = m.running;
				if (!m.running) { liveText = ''; liveMsgId = null; }
				render();
				break;
			case 'live':
				liveText = m.text;
				liveMsgId = m.msgId;
				render();
				break;
			case 'step':
			case 'stepUpdate': {
				const sess = sessions.find((s) => s.id === m.sessionId);
				const msg = sess && sess.messages.find((x) => x.id === m.msgId);
				if (!msg) { break; }
				msg.steps = msg.steps || [];
				if (m.type === 'step') { msg.steps.push(m.step); }
				else {
					const st = msg.steps.find((x) => x.id === m.id);
					if (st) { Object.assign(st, m.patch); }
				}
				render();
				break;
			}
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
