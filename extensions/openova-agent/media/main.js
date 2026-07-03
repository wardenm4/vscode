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
	let providers = [];
	let workspace = null;
	let running = false;
	let liveText = '';
	let liveMsgId = null;
	let queue = [];
	// model picker state
	let pickerOpen = false;
	let pickerProvider = null;
	let pickerModels = [];
	let pickerLoading = false;

	const EFFORTS = [
		['off', 'Auto'],
		['low', 'Low'],
		['medium', 'Med'],
		['high', 'High'],
		['max', 'Max']
	];

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
			return el('span', 'spin');
		}
		// allow-any-unicode-next-line
		return document.createTextNode(step.status === 'error' ? '✕' : step.kind === 'thought' ? '·' : '✓');
	}

	function basename(p) {
		const parts = String(p).split(/[\\/]/);
		return parts[parts.length - 1] || p;
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
				'Ask Openova anything, or use Agent mode to build autonomously' +
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
				if (m.writes && m.writes.length && !m.reviewDismissed && !running) {
					box.appendChild(renderReviewBar(m));
				}
				msgs.appendChild(box);
			}
		}
		app.appendChild(msgs);

		// queued follow-ups
		if (queue.length) {
			const qwrap = el('div', 'queued');
			for (const q of queue) {
				const chip = el('span', 'qchip');
				chip.appendChild(el('span', 'qlabel', 'queued'));
				chip.appendChild(document.createTextNode(q.text.length > 60 ? q.text.slice(0, 60) + '…' : q.text));
				// allow-any-unicode-next-line
				const x = el('span', 'x', ' ✕');
				x.onclick = () => vscode.postMessage({ type: 'cancelQueued', sessionId: active, id: q.id });
				chip.appendChild(x);
				qwrap.appendChild(chip);
			}
			app.appendChild(qwrap);
		}

		// composer
		const composer = el('div', 'composer');
		const ta = document.createElement('textarea');
		ta.placeholder = running ? 'Running… (Enter queues a follow-up)' : 'Ask, or describe what to build…';
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

		const model = el('button', 'model', settings.model || 'model?');
		model.title = 'Provider, model & effort';
		model.onclick = () => {
			pickerOpen = !pickerOpen;
			if (pickerOpen) {
				pickerProvider = settings.provider;
				pickerModels = [];
				pickerLoading = true;
				vscode.postMessage({ type: 'listModels', provider: pickerProvider });
			}
			render();
		};
		bar.appendChild(model);

		const send = el('button', 'send' + (running ? ' stop' : ''), running ? 'Stop' : 'Send');
		send.onclick = () => {
			if (running) { vscode.postMessage({ type: 'abort', sessionId: active }); }
			else { submit(ta); }
		};
		bar.appendChild(send);
		composer.appendChild(bar);
		if (pickerOpen) { composer.appendChild(renderPicker()); }
		app.appendChild(composer);

		msgs.scrollTop = msgs.scrollHeight;
	}

	function renderPicker() {
		const panel = el('div', 'picker');
		const panes = el('div', 'panes');
		const provPane = el('div', 'prov-pane');
		provPane.appendChild(el('div', 'pane-head', 'Provider'));
		for (const p of providers) {
			const b = el('button', 'prov' + (p.id === pickerProvider ? ' view' : ''), p.label);
			if (p.id === settings.provider) { b.classList.add('current'); }
			b.onclick = () => {
				pickerProvider = p.id;
				pickerModels = [];
				pickerLoading = true;
				vscode.postMessage({ type: 'listModels', provider: p.id });
				render();
			};
			provPane.appendChild(b);
		}
		panes.appendChild(provPane);
		const modPane = el('div', 'mod-pane');
		modPane.appendChild(el('div', 'pane-head', pickerLoading ? 'Model (discovering…)' : 'Model'));
		const list = el('div', 'mod-list');
		if (!pickerModels.length && !pickerLoading) {
			list.appendChild(el('div', 'mod-empty', 'No models found'));
		}
		for (const m of pickerModels) {
			const b = el('button', 'mod' + (m === settings.model && pickerProvider === settings.provider ? ' active' : ''), m);
			b.onclick = () => {
				vscode.postMessage({ type: 'setSettings', patch: { provider: pickerProvider, model: m } });
				pickerOpen = false;
				render();
			};
			list.appendChild(b);
		}
		modPane.appendChild(list);
		panes.appendChild(modPane);
		panel.appendChild(panes);
		const eff = el('div', 'effort');
		eff.appendChild(el('span', 'pane-head', 'Effort'));
		const seg = el('div', 'seg');
		for (const [v, label] of EFFORTS) {
			const b = el('button', settings.effort === v ? 'active' : '', label);
			b.onclick = () => vscode.postMessage({ type: 'setSettings', patch: { reasoningEffort: v } });
			seg.appendChild(b);
		}
		eff.appendChild(seg);
		panel.appendChild(eff);
		return panel;
	}

	function renderReviewBar(m) {
		const bar = el('div', 'review');
		const head = el('div', 'rhead');
		let added = 0;
		let removed = 0;
		for (const w of m.writes) { added += w.added; removed += w.removed; }
		const sum = el('span', 'rsum', m.writes.length + ' file' + (m.writes.length === 1 ? '' : 's') + ' changed');
		if (added) { sum.appendChild(el('span', 'radd', ' +' + added)); }
		if (removed) { sum.appendChild(el('span', 'rdel', ' -' + removed)); }
		head.appendChild(sum);
		const undo = el('button', 'rundo', 'Undo all');
		undo.onclick = () => vscode.postMessage({ type: 'undoWrites', sessionId: active, msgId: m.id });
		head.appendChild(undo);
		const keep = el('button', 'rkeep', 'Keep all');
		keep.onclick = () => vscode.postMessage({ type: 'dismissReview', sessionId: active, msgId: m.id });
		head.appendChild(keep);
		bar.appendChild(head);
		const files = el('div', 'rfiles');
		for (const w of m.writes) {
			const row = el('div', 'rfile');
			row.title = w.fullPath;
			row.appendChild(el('span', 'rname', basename(w.path)));
			if (w.isNew) { row.appendChild(el('span', 'rnew', 'new')); }
			const counts = el('span', 'rcounts');
			if (w.added) { counts.appendChild(el('span', 'radd', '+' + w.added)); }
			if (w.removed) { counts.appendChild(el('span', 'rdel', '-' + w.removed)); }
			row.appendChild(counts);
			if (!w.isNew && w.before !== undefined) {
				const rv = el('button', 'rrevert', 'Revert');
				rv.onclick = () =>
					vscode.postMessage({ type: 'revertFile', sessionId: active, msgId: m.id, fullPath: w.fullPath });
				row.appendChild(rv);
			}
			files.appendChild(row);
		}
		bar.appendChild(files);
		return bar;
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
		if (!text) { return; }
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
				providers = m.providers || [];
				workspace = m.workspace;
				queue = m.queue || [];
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
			case 'queue':
				if (m.sessionId === active) { queue = m.items || []; }
				render();
				break;
			case 'models':
				if (m.provider === pickerProvider) {
					pickerModels = m.models || [];
					pickerLoading = false;
				}
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
