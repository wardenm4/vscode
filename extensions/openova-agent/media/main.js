/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');
	const isWindow = document.body.dataset.mode === 'window';

	let sessions = [];
	let active = null;
	let settings = { provider: 'ollama', model: '', effort: 'off' };
	let providers = [];
	let workspace = null;
	let running = false;
	let liveText = '';
	let liveMsgId = null;
	let queue = [];
	let draft = '';
	let automations = [];
	// window-mode navigation
	let view = 'chat'; // 'chat' | 'automations'
	let sidebarSearch = null; // null = closed, string = filter
	let focusSearch = false;
	// model picker state
	let pickerOpen = false;
	let pickerProvider = null;
	let pickerModels = [];
	let pickerLoading = false;
	// @-mention state
	let contextChips = [];
	let wsFiles = null;
	let mentionQuery = null;

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

	const SVG_NS = 'http://www.w3.org/2000/svg';
	function icon(d, size) {
		const s = document.createElementNS(SVG_NS, 'svg');
		s.setAttribute('viewBox', '0 0 16 16');
		s.setAttribute('width', String(size || 14));
		s.setAttribute('height', String(size || 14));
		s.setAttribute('aria-hidden', 'true');
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('d', d);
		p.setAttribute('fill', 'currentColor');
		s.appendChild(p);
		return s;
	}
	const ICONS = {
		spark: 'M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z',
		search: 'M6.5 1a5.5 5.5 0 014.23 9.02l4.13 4.13-1.06 1.06-4.13-4.12A5.5 5.5 0 116.5 1zm0 1.5a4 4 0 100 8 4 4 0 000-8z',
		clock: 'M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zm.75 1.5v3.7l2.53 2.52-1.06 1.06L7.25 8.31V4h1.5z',
		sliders: 'M1 3.5h9V5H1V3.5zm11.5 0H15V5h-2.5V3.5zM10 1.75h1.5v5H10v-5zM1 11h2.5v1.5H1V11zm5.5 0H15v1.5H6.5V11zM4 9.25h1.5v5H4v-5z',
		folder: 'M1.5 3a1 1 0 011-1h3.6l1.3 1.5h6.1a1 1 0 011 1V12a1 1 0 01-1 1h-11a1 1 0 01-1-1V3zm1.5.5V11.5h10V5H6.7L5.4 3.5H3z',
		up: 'M8 2.5l4.75 4.75-1.06 1.06-2.94-2.94V13.5h-1.5V5.37L4.31 8.31 3.25 7.25 8 2.5z',
		stop: 'M4 4h8v8H4z',
		external: 'M6 3h7v7h-1.5V5.56L4.53 12.53 3.47 11.47 10.44 4.5H6V3z',
		chevron: 'M4.5 6l3.5 3.5L11.5 6l1 1-4.5 4.5L3.5 7l1-1z',
		display: 'M1.5 3h13a.5.5 0 01.5.5V11a.5.5 0 01-.5.5H9v1h2V14H5v-1.5h2v-1H1.5A.5.5 0 011 11V3.5a.5.5 0 01.5-.5zm1 1.5V10h11V4.5h-11z'
	};

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

	function age(ts) {
		if (!ts) { return ''; }
		const d = Date.now() - ts;
		if (d < 3_600_000) { return Math.max(1, Math.round(d / 60_000)) + 'm'; }
		if (d < 86_400_000) { return Math.round(d / 3_600_000) + 'h'; }
		return Math.round(d / 86_400_000) + 'd';
	}

	// ---- shared composer ----
	function buildComposer(big) {
		const composer = el('div', 'composer' + (big ? ' home-composer' : ''));
		renderChips(composer);
		const ta = document.createElement('textarea');
		ta.placeholder = running
			? 'Running… (Enter queues a follow-up)'
			: big
				? 'Plan, build, or ask anything…  @ for context'
				: 'Ask, or describe what to build…  @ attaches files';
		ta.rows = big ? 2 : 1;
		ta.value = draft;
		ta.onkeydown = (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				submit(ta);
			} else if (e.key === 'Tab' && e.shiftKey) {
				e.preventDefault();
				state.mode = state.mode === 'plan' ? 'agent' : 'plan';
				vscode.setState(state);
				render();
			}
		};
		ta.oninput = () => {
			draft = ta.value;
			if (!big) {
				ta.style.height = 'auto';
				ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
			}
			onComposerInput(ta);
		};
		composer.appendChild(ta);

		const bar = el('div', 'bar');
		const attach = el('button', 'attach', '+');
		attach.title = 'Attach files for context (@)';
		attach.onclick = () => {
			ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + '@';
			draft = ta.value;
			ta.focus();
			onComposerInput(ta);
		};
		bar.appendChild(attach);

		const mode = document.createElement('select');
		mode.className = 'mode';
		for (const [v, label] of [['agent', 'Agent'], ['ask', 'Ask'], ['plan', 'Plan']]) {
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

		const model = el('button', 'model', settings.model || 'Auto');
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
		bar.appendChild(el('span', 'spacer'));

		const send = el('button', 'send' + (running ? ' stop' : ''));
		send.title = running ? 'Stop' : 'Send';
		send.appendChild(icon(running ? ICONS.stop : ICONS.up, 13));
		send.onclick = () => {
			if (running) { vscode.postMessage({ type: 'abort', sessionId: active }); }
			else { submit(ta); }
		};
		bar.appendChild(send);
		composer.appendChild(bar);
		if (pickerOpen) { composer.appendChild(renderPicker()); }
		return { composer, ta };
	}

	// ---- rendering ----
	function render() {
		app.textContent = '';
		if (isWindow) {
			renderWindow();
			return;
		}
		renderSidebarMode();
	}

	// ============ agents-window shell: sidebar + main pane ============
	function renderWindow() {
		const shell = el('div', 'win-shell');
		shell.appendChild(renderRail());
		const main = el('div', 'win-main');
		const sess = sessions.find((s) => s.id === active);

		// slim top bar with a hop back to the editor window
		const top = el('div', 'win-top');
		top.appendChild(el('span', 'spacer'));
		const ed = el('button', 'linkish');
		ed.appendChild(document.createTextNode('Editor Window'));
		ed.appendChild(icon(ICONS.external, 11));
		ed.onclick = () => vscode.postMessage({ type: 'editorWindow' });
		top.appendChild(ed);
		main.appendChild(top);

		if (view === 'automations') {
			renderAutomations(main);
		} else if (sess && sess.messages.length > 0) {
			renderTranscript(main, sess, true);
		} else {
			renderHome(main);
		}
		shell.appendChild(main);
		app.appendChild(shell);
	}

	function renderRail() {
		const rail = el('div', 'rail');
		const nav = el('div', 'rail-nav');
		const item = (ic, label, onclick, isActive) => {
			const b = el('button', 'rail-item' + (isActive ? ' active' : ''));
			b.appendChild(icon(ic));
			b.appendChild(el('span', '', label));
			b.onclick = onclick;
			nav.appendChild(b);
			return b;
		};
		item(ICONS.spark, 'New Agent', () => {
			view = 'chat';
			pickerOpen = false;
			vscode.postMessage({ type: 'newSession' });
		}, view === 'chat' && !(sessions.find((s) => s.id === active)?.messages.length));
		item(ICONS.search, 'Search', () => {
			sidebarSearch = sidebarSearch === null ? '' : null;
			focusSearch = sidebarSearch !== null;
			render();
		}, sidebarSearch !== null);
		item(ICONS.clock, 'Automations', () => {
			view = 'automations';
			render();
		}, view === 'automations');
		item(ICONS.sliders, 'Customize', () => vscode.postMessage({ type: 'customize' }), false);
		rail.appendChild(nav);

		if (sidebarSearch !== null) {
			const si = document.createElement('input');
			si.className = 'rail-search';
			si.placeholder = 'Search agents…';
			si.value = sidebarSearch;
			si.oninput = () => {
				sidebarSearch = si.value;
				renderRailSessions(rail);
			};
			si.onkeydown = (e) => {
				if (e.key === 'Escape') {
					sidebarSearch = null;
					render();
				}
			};
			rail.appendChild(si);
			if (focusSearch) {
				focusSearch = false;
				setTimeout(() => si.focus(), 0);
			}
		}

		rail.appendChild(el('div', 'rail-head', 'Repositories'));
		const scroller = el('div', 'rail-scroll');
		rail.appendChild(scroller);
		renderRailSessions(rail);

		const foot = el('div', 'rail-foot');
		const gear = el('button', 'rail-gear');
		gear.title = 'Openova settings';
		// allow-any-unicode-next-line
		gear.textContent = '⚙';
		gear.onclick = () => vscode.postMessage({ type: 'openSettings' });
		foot.appendChild(el('span', 'spacer'));
		foot.appendChild(gear);
		rail.appendChild(foot);
		return rail;
	}

	function renderRailSessions(rail) {
		const scroller = rail.querySelector('.rail-scroll');
		scroller.textContent = '';
		const repo = el('div', 'repo');
		const rh = el('div', 'repo-name');
		rh.appendChild(icon(ICONS.folder, 13));
		rh.appendChild(el('span', '', workspace || 'No folder open'));
		repo.appendChild(rh);
		scroller.appendChild(repo);

		const q = (sidebarSearch || '').toLowerCase();
		const list = sessions.filter(
			(s) => s.messages.length > 0 && (!q || (s.title || '').toLowerCase().includes(q))
		);
		if (!list.length) {
			scroller.appendChild(el('div', 'rail-empty', q ? 'No matches' : 'No agents yet'));
			return;
		}
		for (const s of list) {
			const row = el('div', 'rail-sess' + (s.id === active && view === 'chat' ? ' active' : ''));
			row.appendChild(el('span', 'rs-title', s.title || 'Agent'));
			row.appendChild(el('span', 'rs-age', age(s.updatedAt)));
			// allow-any-unicode-next-line
			const x = el('button', 'rs-x', '✕');
			x.title = 'Delete';
			x.onclick = (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'deleteSession', id: s.id });
			};
			row.appendChild(x);
			row.onclick = () => {
				view = 'chat';
				vscode.postMessage({ type: 'switchSession', id: s.id });
			};
			scroller.appendChild(row);
		}
	}

	function renderHome(main) {
		const home = el('div', 'home');
		const inner = el('div', 'home-inner');

		// repo + machine row, Cursor-style
		const where = el('div', 'where');
		const repo = el('button', 'where-repo');
		repo.appendChild(el('span', '', workspace || 'Open a folder'));
		repo.appendChild(icon(ICONS.chevron, 11));
		repo.title = 'Open a recent folder';
		repo.onclick = () => vscode.postMessage({ type: 'openRepo' });
		where.appendChild(repo);
		const local = el('span', 'where-local');
		local.appendChild(icon(ICONS.display, 12));
		local.appendChild(el('span', '', 'Local'));
		where.appendChild(local);
		inner.appendChild(where);

		const { composer, ta } = buildComposer(true);
		inner.appendChild(composer);

		// suggestion chips
		const sugg = el('div', 'sugg');
		const planChip = el('button', 'sugg-chip');
		planChip.appendChild(el('span', '', 'Plan New Idea'));
		// allow-any-unicode-next-line
		planChip.appendChild(el('span', 'kbd', '⇧Tab'));
		planChip.onclick = () => {
			state.mode = 'plan';
			vscode.setState(state);
			render();
		};
		sugg.appendChild(planChip);
		const buildChip = el('button', 'sugg-chip', 'Build');
		buildChip.onclick = () => {
			state.mode = 'agent';
			vscode.setState(state);
			render();
		};
		sugg.appendChild(buildChip);
		inner.appendChild(sugg);

		home.appendChild(inner);
		const hint = el('div', 'home-hint');
		hint.appendChild(document.createTextNode('Agents read and write workspace files and run gated commands. Use '));
		hint.appendChild(el('span', 'kbd-pill', '@'));
		hint.appendChild(document.createTextNode(' to attach files for context'));
		home.appendChild(hint);
		main.appendChild(home);
		if (state.mode === 'plan') { planChip.classList.add('on'); }
		if (!pickerOpen) { setTimeout(() => ta.focus(), 0); }
	}

	const INTERVALS = [
		[15, 'Every 15 min'],
		[30, 'Every 30 min'],
		[60, 'Every hour'],
		[240, 'Every 4 hours'],
		[1440, 'Daily']
	];

	function renderAutomations(main) {
		const pane = el('div', 'autom');
		const col = el('div', 'autom-col');
		col.appendChild(el('div', 'autom-title', 'Automations'));
		col.appendChild(
			el(
				'div',
				'autom-sub',
				'Recurring agent runs in this repository — nightly test triage, dependency audits, doc sweeps. Each run opens as a new agent session.'
			)
		);

		if (automations.length) {
			const list = el('div', 'autom-list');
			for (const a of automations) {
				const row = el('div', 'autom-row' + (a.enabled ? '' : ' off'));
				const toggle = document.createElement('input');
				toggle.type = 'checkbox';
				toggle.checked = !!a.enabled;
				toggle.title = a.enabled ? 'Disable' : 'Enable';
				toggle.onchange = () =>
					vscode.postMessage({ type: 'automationSave', item: { id: a.id, enabled: toggle.checked } });
				row.appendChild(toggle);
				const meta = el('div', 'autom-meta');
				meta.appendChild(el('div', 'autom-name', a.name));
				const cadence = (INTERVALS.find((x) => x[0] === a.everyMinutes) || [0, 'Every ' + a.everyMinutes + ' min'])[1];
				meta.appendChild(
					el('div', 'autom-when', cadence + (a.lastRun ? '  ·  last run ' + age(a.lastRun) + ' ago' : '  ·  never run'))
				);
				row.appendChild(meta);
				const run = el('button', 'autom-run', running ? 'Busy…' : 'Run now');
				run.disabled = running;
				run.onclick = () => {
					view = 'chat';
					vscode.postMessage({ type: 'automationRun', id: a.id });
				};
				row.appendChild(run);
				// allow-any-unicode-next-line
				const del = el('button', 'autom-del', '✕');
				del.title = 'Delete automation';
				del.onclick = () => vscode.postMessage({ type: 'automationDelete', id: a.id });
				row.appendChild(del);
				row.title = a.prompt;
				list.appendChild(row);
			}
			col.appendChild(list);
		}

		// new-automation form
		const form = el('div', 'autom-form');
		form.appendChild(el('div', 'autom-form-head', 'New automation'));
		const name = document.createElement('input');
		name.placeholder = 'Name — e.g. Nightly test triage';
		form.appendChild(name);
		const prompt = document.createElement('textarea');
		prompt.placeholder = 'What should the agent do each run?';
		prompt.rows = 3;
		form.appendChild(prompt);
		const foot = el('div', 'autom-form-foot');
		const interval = document.createElement('select');
		for (const [v, label] of INTERVALS) {
			const o = document.createElement('option');
			o.value = String(v);
			o.textContent = label;
			interval.appendChild(o);
		}
		interval.value = '60';
		foot.appendChild(interval);
		foot.appendChild(el('span', 'spacer'));
		const save = el('button', 'autom-save', 'Create');
		save.onclick = () => {
			if (!name.value.trim() || !prompt.value.trim()) { return; }
			vscode.postMessage({
				type: 'automationSave',
				item: { name: name.value.trim(), prompt: prompt.value.trim(), everyMinutes: Number(interval.value) }
			});
			name.value = '';
			prompt.value = '';
		};
		foot.appendChild(save);
		form.appendChild(foot);
		col.appendChild(form);

		pane.appendChild(col);
		main.appendChild(pane);
	}

	function renderTranscript(main, sess, windowed) {
		// header (sidebar mode only — the window shell has its own rail)
		if (!windowed) {
			const head = el('div', 'head');
			const logo = document.createElement('img');
			logo.src = document.body.dataset.icon;
			head.appendChild(logo);
			head.appendChild(el('span', 'title', (sess && sess.title) || 'Openova Agent'));
			const plus = el('button', '', '+');
			plus.title = 'New chat';
			plus.onclick = () => vscode.postMessage({ type: 'newSession' });
			head.appendChild(plus);
			main.appendChild(head);

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
				main.appendChild(strip);
			}
		} else {
			const th = el('div', 'sess-head');
			th.appendChild(el('span', 'sess-title', sess.title || 'Agent'));
			th.appendChild(el('span', 'sess-age', age(sess.updatedAt)));
			main.appendChild(th);
		}

		const msgs = el('div', 'msgs');
		if (!sess || sess.messages.length === 0) {
			const empty = el('div', 'empty');
			empty.textContent =
				'Ask Openova anything, or use Agent mode to build autonomously' +
				(workspace ? ' in ' + workspace : '') +
				'. The agent reads and writes workspace files and runs gated commands.';
			msgs.appendChild(empty);
		} else {
			for (let mi = 0; mi < sess.messages.length; mi++) {
				const m = sess.messages[mi];
				const box = el('div', 'msg ' + m.role);
				const who = el('div', 'who', m.role === 'user' ? 'You' : 'Openova');
				// Checkpoint: a user turn whose run recorded restorable writes gets
				// a whole-run restore affordance (works even after Keep all).
				if (m.role === 'user') {
					const next = sess.messages[mi + 1];
					const restorable =
						next && next.writes && next.writes.some((w) => w.isNew || w.before !== undefined);
					if (restorable) {
						const rc = el('button', 'restore', 'Restore checkpoint');
						rc.title = 'Restore every file this turn changed to its pre-run state';
						rc.onclick = () =>
							vscode.postMessage({ type: 'undoWrites', sessionId: active, msgId: next.id });
						who.appendChild(rc);
					}
				}
				box.appendChild(who);
				if (m.steps && m.steps.length) {
					const steps = el('div', 'steps');
					// Collapse consecutive repeats of the same action into one row
					// with a repeat count — agents often retry the same edit.
					let si = 0;
					while (si < m.steps.length) {
						let sj = si + 1;
						while (sj < m.steps.length && m.steps[sj].title === m.steps[si].title) { sj++; }
						steps.appendChild(renderStep(m.steps[sj - 1], sj - si));
						si = sj;
					}
					box.appendChild(steps);
				}
				if (m.plan) {
					box.appendChild(renderPlan(m));
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
		main.appendChild(msgs);

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
			main.appendChild(qwrap);
		}

		const { composer } = buildComposer(false);
		main.appendChild(composer);
		msgs.scrollTop = msgs.scrollHeight;
	}

	// ============ sidebar (view) mode — unchanged layout ============
	function renderSidebarMode() {
		const sess = sessions.find((s) => s.id === active);
		renderTranscript(app, sess, false);
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

	function renderPlan(m) {
		const p = m.plan;
		const card = el('div', 'plan ' + p.status);
		const head = el('div', 'phead');
		head.appendChild(el('span', 'ptitle', p.title));
		const done = p.steps.filter((s) => s.done).length;
		const badge =
			p.status === 'proposed' ? 'Awaiting approval'
				: p.status === 'running' ? 'Running ' + done + '/' + p.steps.length
					: p.status === 'done' ? 'Completed' : 'Cancelled';
		head.appendChild(el('span', 'pbadge ' + p.status, badge));
		card.appendChild(head);
		const steps = el('div', 'psteps');
		const editable = p.status === 'proposed';
		p.steps.forEach((s, i) => {
			const row = el('div', 'pstep' + (s.done ? ' done' : ''));
			const mark = el('span', 'pmark');
			// allow-any-unicode-next-line
			mark.textContent = s.done ? '✓' : String(i + 1);
			row.appendChild(mark);
			if (editable) {
				const input = document.createElement('input');
				input.value = s.text;
				input.placeholder = 'Describe this step…';
				input.onchange = () =>
					vscode.postMessage({ type: 'planEdit', sessionId: active, msgId: m.id, stepId: s.id, text: input.value });
				row.appendChild(input);
				// allow-any-unicode-next-line
				const rm = el('button', 'prm', '✕');
				rm.title = 'Remove step';
				rm.onclick = () =>
					vscode.postMessage({ type: 'planRemove', sessionId: active, msgId: m.id, stepId: s.id });
				row.appendChild(rm);
			} else {
				row.appendChild(el('span', 'ptext', s.text));
			}
			steps.appendChild(row);
		});
		card.appendChild(steps);
		if (editable) {
			const actions = el('div', 'pactions');
			const add = el('button', 'padd', '+ Add step');
			add.onclick = () => vscode.postMessage({ type: 'planAdd', sessionId: active, msgId: m.id });
			actions.appendChild(add);
			actions.appendChild(el('span', 'pspacer'));
			const cancel = el('button', 'pcancel', 'Cancel');
			cancel.onclick = () => vscode.postMessage({ type: 'planCancel', sessionId: active, msgId: m.id });
			actions.appendChild(cancel);
			const approve = el('button', 'papprove', 'Approve & Run');
			approve.disabled = running;
			approve.onclick = () => vscode.postMessage({ type: 'planApprove', sessionId: active, msgId: m.id });
			actions.appendChild(approve);
			card.appendChild(actions);
		}
		return card;
	}

	function renderStep(st, count) {
		const box = el('div', 'step ' + st.status + (st.kind === 'thought' ? ' thought' : ''));
		const row = el('div', 'row');
		const g = el('span', 'glyph');
		g.appendChild(glyphFor(st));
		row.appendChild(g);
		row.appendChild(el('span', 't', st.title));
		if (count > 1) {
			// allow-any-unicode-next-line
			row.appendChild(el('span', 'xn', '×' + count));
		}
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
		draft = '';
		const ctx = contextChips.slice();
		contextChips = [];
		mentionQuery = null;
		vscode.postMessage({ type: 'send', sessionId: active, text, mode: state.mode, context: ctx });
	}

	// ---- @-mentions ----
	function onComposerInput(ta) {
		const m = /@([\w./\\-]*)$/.exec(ta.value);
		const q = m ? m[1] : null;
		if (q !== null && wsFiles === null) {
			wsFiles = [];
			vscode.postMessage({ type: 'listWorkspaceFiles' });
		}
		if (q !== mentionQuery) {
			mentionQuery = q;
			renderMention(ta);
		}
	}

	function renderMention(ta) {
		const old = document.querySelector('.mention');
		if (old) { old.remove(); }
		if (mentionQuery === null || !wsFiles) { return; }
		const q = mentionQuery.toLowerCase();
		const matches = wsFiles
			.filter((f) => !contextChips.includes(f) && f.toLowerCase().includes(q))
			.slice(0, 8);
		if (!matches.length) { return; }
		const box = el('div', 'mention');
		for (const f of matches) {
			const row = el('div', 'mrow', f);
			row.onmousedown = (e) => {
				e.preventDefault();
				contextChips.push(f);
				ta.value = ta.value.replace(/@[\w./\\-]*$/, '');
				draft = ta.value;
				mentionQuery = null;
				render();
			};
			box.appendChild(row);
		}
		ta.closest('.composer').appendChild(box);
	}

	function renderChips(composer) {
		if (!contextChips.length) { return; }
		const row = el('div', 'chips');
		for (const c of contextChips) {
			const chip = el('span', 'ctx-chip', '@' + (c.split('/').pop() || c));
			chip.title = c;
			// allow-any-unicode-next-line
			const x = el('span', 'x', ' ✕');
			x.onclick = () => {
				contextChips = contextChips.filter((p) => p !== c);
				render();
			};
			chip.appendChild(x);
			row.appendChild(chip);
		}
		composer.appendChild(row);
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
				automations = m.automations || [];
				if (m.view) { view = m.view; }
				render();
				break;
			case 'automations':
				automations = m.items || [];
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
			case 'workspaceFiles': {
				wsFiles = m.files || [];
				const ta = document.querySelector('.composer textarea');
				if (ta) { renderMention(ta); }
				break;
			}
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
