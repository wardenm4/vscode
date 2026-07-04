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
	let repos = [];
	let repoCurrent = null;
	// side tool pane (Agents window): null | 'files' | 'browser' | 'terminal'
	let toolView = null;
	let currentFile = null;
	let fileContent = '';
	let followAgent = true;
	const sessionFiles = [];
	let browserUrl = 'http://localhost:5173';
	let browserLoaded = null;
	let termBuffer = '';
	let termStarted = false;
	// live activity heartbeat while a run works
	let activity = null;
	let runStartLocal = 0;
	let activityTimer = null;
	// window-mode navigation
	let view = 'chat'; // 'chat' | 'automations'
	let sidebarSearch = null; // null = closed, string = filter
	let focusSearch = false;
	// model picker state
	let pickerOpen = false;
	let pickerProvider = null;
	let pickerModels = [];
	let pickerLoading = false;
	let pickerError = null;
	let pickerNeedsKey = false;
	let pickerHasKey = false;
	let pickerLocal = false;
	let pickerBaseURL = '';
	let pickerDiscovered = false;
	let currentTheme = '';
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
		display: 'M1.5 3h13a.5.5 0 01.5.5V11a.5.5 0 01-.5.5H9v1h2V14H5v-1.5h2v-1H1.5A.5.5 0 011 11V3.5a.5.5 0 01.5-.5zm1 1.5V10h11V4.5h-11z',
		doc: 'M4 1h5.5L13 4.5V15H4V1zm1.5 1.5v11h6V5.5H8.5V2.5h-3zM10 2.9V4h1.1L10 2.9zM6 7h5v1.2H6V7zm0 2.5h5v1.2H6V9.5z',
		globe: 'M8 1a7 7 0 110 14A7 7 0 018 1zm-.75 1.66A5.5 5.5 0 002.52 7.25h2.6c.1-1.7.5-3.28 1.13-4.59zM8 2.62c-.63 1.13-1.13 2.72-1.25 4.63h2.5C9.13 5.34 8.63 3.75 8 2.62zm2.88 4.63h2.6a5.5 5.5 0 00-4.73-4.59c.64 1.31 1.03 2.9 1.13 4.59zm-.01 1.5c-.1 1.7-.49 3.28-1.12 4.59a5.5 5.5 0 004.73-4.59h-2.61zM8 13.38c.63-1.13 1.13-2.72 1.25-4.63h-2.5c.12 1.91.62 3.5 1.25 4.63zm-2.88-4.63h-2.6a5.5 5.5 0 004.73 4.59c-.63-1.31-1.03-2.9-1.13-4.59z',
		term: 'M2 3h12a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1zm.5 1.5v7h11v-7h-11zM4 6l2.2 1.9L4 9.8l.9 1L8 7.9 4.9 5.1 4 6zm4.5 4h3.5v1.2H8.5V10z'
	};

	// ---- lightweight markdown → DOM (no innerHTML with model text) ----
	// Inline: **bold**, *italic*, `code`. Block: headings, bullet lists, fences.
	function looksLikePath(s) {
		if (s.length > 220 || /\s{2,}/.test(s)) { return false; }
		return /\.[a-zA-Z0-9]{1,6}$/.test(s.trim()) && !/[<>"|?*]/.test(s);
	}

	function openInternalFile(p) {
		if (!isWindow) {
			// the sidebar has no tool panes — open a real editor tab instead
			vscode.postMessage({ type: 'openInEditor', path: p.trim() });
			return;
		}
		toolView = 'files';
		followAgent = false;
		view = 'chat';
		currentFile = p.trim();
		fileContent = '';
		vscode.postMessage({ type: 'readFileContent', path: currentFile });
		render();
	}

	function mdInline(target, text) {
		const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
		let last = 0;
		let m;
		while ((m = re.exec(text))) {
			if (m.index > last) { target.appendChild(document.createTextNode(text.slice(last, m.index))); }
			const tok = m[0];
			if (tok.startsWith('**')) {
				target.appendChild(el('strong', '', tok.slice(2, -2)));
			} else if (tok.startsWith('`')) {
				const inner = tok.slice(1, -1);
				if (looksLikePath(inner)) {
					// file reference — opens in the in-app Editor pane
					const link = el('button', 'md-file', inner);
					link.title = 'Open in the Editor pane';
					link.onclick = () => openInternalFile(inner);
					target.appendChild(link);
				} else {
					target.appendChild(el('code', 'md-code', inner));
				}
			} else {
				target.appendChild(el('em', '', tok.slice(1, -1)));
			}
			last = m.index + tok.length;
		}
		if (last < text.length) { target.appendChild(document.createTextNode(text.slice(last))); }
	}

	function renderBody(container, text) {
		container.textContent = '';
		const parts = String(text).split(/```[\w-]*\n?/);
		for (let i = 0; i < parts.length; i++) {
			if (!parts[i]) { continue; }
			if (i % 2 === 1) {
				const pre = el('pre');
				pre.textContent = parts[i].replace(/\n$/, '');
				container.appendChild(pre);
				continue;
			}
			// block-level pass over non-fenced text
			const lines = parts[i].split('\n');
			let list = null;
			for (const line of lines) {
				const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
				if (bullet) {
					if (!list) {
						list = el('ul', 'md-list');
						container.appendChild(list);
					}
					const li = el('li');
					mdInline(li, bullet[1]);
					list.appendChild(li);
					continue;
				}
				list = null;
				const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
				if (heading) {
					const h = el('div', 'md-h md-h' + heading[1].length);
					mdInline(h, heading[2]);
					container.appendChild(h);
					continue;
				}
				if (!line.trim()) { continue; }
				const p = el('div', 'md-p');
				mdInline(p, line);
				container.appendChild(p);
			}
		}
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

		// slim top bar: tool-pane toggles (editor / browser / terminal) + editor hop
		const top = el('div', 'win-top');
		const inChat = view === 'chat' && sess && sess.messages.length > 0;
		const toolBtn = (key, ic, tip) => {
			const b = el('button', 'toolbtn' + (toolView === key ? ' on' : ''));
			b.appendChild(icon(ic, 14));
			b.title = tip;
			b.onclick = () => {
				toolView = toolView === key ? null : key;
				if (toolView === 'terminal' && !termStarted) {
					termStarted = true;
					vscode.postMessage({ type: 'termStart' });
				}
				render();
			};
			top.appendChild(b);
		};
		if (inChat) {
			toolBtn('files', ICONS.doc, 'Editor — watch the files the agent writes');
			toolBtn('browser', ICONS.globe, 'Browser — preview localhost / any URL');
			toolBtn('terminal', ICONS.term, 'Terminal — a shell in this workspace');
		}
		top.appendChild(el('span', 'spacer'));
		const ed = el('button', 'linkish');
		ed.appendChild(document.createTextNode('Editor Window'));
		ed.appendChild(icon(ICONS.external, 11));
		ed.onclick = () => vscode.postMessage({ type: 'editorWindow' });
		top.appendChild(ed);
		main.appendChild(top);

		if (view === 'automations') {
			renderAutomations(main);
		} else if (view === 'customize') {
			renderCustomize(main);
		} else if (sess && sess.messages.length > 0) {
			if (toolView) {
				const split = el('div', 'split');
				const chatCol = el('div', 'chat-col');
				renderTranscript(chatCol, sess, true);
				split.appendChild(chatCol);
				split.appendChild(renderToolPane(sess));
				main.appendChild(split);
			} else {
				renderTranscript(main, sess, true);
			}
		} else {
			renderHome(main);
		}
		shell.appendChild(main);
		app.appendChild(shell);
	}

	// ---- side tool panes: editor / browser / terminal ----
	function renderToolPane(sess) {
		const pane = el('div', 'tool-col');
		if (toolView === 'files') {
			const head = el('div', 'tool-head');
			// files the agent touched this session (latest first)
			const touched = [];
			for (const m of sess.messages) {
				for (const w of m.writes || []) {
					if (!touched.includes(w.path)) { touched.unshift(w.path); }
				}
			}
			for (const p of sessionFiles) {
				if (!touched.includes(p)) { touched.unshift(p); }
			}
			const sel = document.createElement('select');
			sel.className = 'tool-file-sel';
			if (!touched.length) {
				const o = document.createElement('option');
				o.textContent = 'No files written yet';
				sel.appendChild(o);
				sel.disabled = true;
			}
			for (const p of touched) {
				const o = document.createElement('option');
				o.value = p;
				o.textContent = p;
				sel.appendChild(o);
			}
			if (currentFile) { sel.value = currentFile; }
			sel.onchange = () => {
				currentFile = sel.value;
				vscode.postMessage({ type: 'readFileContent', path: currentFile });
			};
			head.appendChild(sel);
			const follow = el('button', 'tool-mini' + (followAgent ? ' on' : ''), 'Follow');
			follow.title = 'Automatically show the file the agent is writing';
			follow.onclick = () => {
				followAgent = !followAgent;
				render();
			};
			head.appendChild(follow);
			const open = el('button', 'tool-mini', 'Open');
			open.title = 'Open this file in the editor';
			open.onclick = () => {
				if (currentFile) { vscode.postMessage({ type: 'openInEditor', path: currentFile }); }
			};
			head.appendChild(open);
			pane.appendChild(head);
			const body = el('pre', 'tool-code');
			body.textContent = currentFile
				? fileContent || '(loading…)'
				: 'The file the agent is writing shows here live.\nPick a file above, or wait for the agent to write one.';
			pane.appendChild(body);
		} else if (toolView === 'browser') {
			const head = el('div', 'tool-head');
			const url = document.createElement('input');
			url.className = 'tool-url';
			url.value = browserUrl;
			url.placeholder = 'http://localhost:5173';
			url.onkeydown = (e) => {
				if (e.key === 'Enter') {
					browserUrl = url.value.trim();
					if (browserUrl && !/^https?:\/\//i.test(browserUrl)) { browserUrl = 'http://' + browserUrl; }
					browserLoaded = browserUrl;
					render();
				}
			};
			head.appendChild(url);
			const go = el('button', 'tool-mini', 'Go');
			go.onclick = () => {
				browserUrl = url.value.trim();
				if (browserUrl && !/^https?:\/\//i.test(browserUrl)) { browserUrl = 'http://' + browserUrl; }
				browserLoaded = browserUrl;
				render();
			};
			head.appendChild(go);
			// allow-any-unicode-next-line
			const re = el('button', 'tool-mini', '⟳');
			re.title = 'Reload';
			re.onclick = () => {
				const f = pane.querySelector('iframe');
				if (f) { f.src = f.src; }
			};
			head.appendChild(re);
			pane.appendChild(head);
			if (browserLoaded) {
				const frame = document.createElement('iframe');
				frame.className = 'tool-frame';
				frame.src = browserLoaded;
				frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
				pane.appendChild(frame);
			} else {
				const empty = el('div', 'tool-empty');
				empty.appendChild(el('div', '', 'Preview what the agent builds.'));
				empty.appendChild(el('div', 'tool-empty-sub', 'Enter a URL above — dev servers on localhost work best.'));
				pane.appendChild(empty);
			}
		} else if (toolView === 'terminal') {
			const out = el('pre', 'tool-term');
			out.textContent = termBuffer || '(starting shell…)';
			pane.appendChild(out);
			const row = el('div', 'tool-term-row');
			// allow-any-unicode-next-line
			row.appendChild(el('span', 'tool-prompt', '❯'));
			const input = document.createElement('input');
			input.className = 'tool-term-in';
			input.placeholder = 'Type a command, Enter to run';
			input.onkeydown = (e) => {
				if (e.key === 'Enter' && input.value.trim() !== '') {
					const cmd = input.value;
					input.value = '';
					termBuffer += '\n> ' + cmd + '\n';
					if (!termStarted) {
						termStarted = true;
						vscode.postMessage({ type: 'termStart' });
					}
					vscode.postMessage({ type: 'termInput', data: cmd });
					render();
				}
			};
			row.appendChild(input);
			pane.appendChild(row);
			setTimeout(() => {
				out.scrollTop = out.scrollHeight;
				input.focus();
			}, 0);
		}
		return pane;
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
		item(ICONS.sliders, 'Customize', () => {
			view = 'customize';
			render();
		}, view === 'customize');
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
		const q = (sidebarSearch || '').toLowerCase();

		// One group per known repo — current workspace first with live
		// sessions, other repos from the cross-workspace registry.
		const groups = repos.length
			? repos
			: [{ path: null, name: workspace || 'No folder open', sessions: [] }];
		let shownAny = false;
		for (const repo of groups) {
			const isCurrent = repo.path === repoCurrent || repo.path === null;
			const rh = el('div', 'repo-name' + (isCurrent ? ' current' : ''));
			rh.appendChild(icon(ICONS.folder, 13));
			rh.appendChild(el('span', 'rn-label', repo.name));
			if (!isCurrent) {
				// allow-any-unicode-next-line
				const forget = el('button', 'rn-forget', '✕');
				forget.title = 'Remove from list';
				forget.onclick = (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'forgetRepo', path: repo.path });
				};
				rh.appendChild(forget);
				rh.title = 'Open ' + repo.path;
				rh.onclick = () => vscode.postMessage({ type: 'openRepoFolder', path: repo.path });
			} else {
				rh.title = repo.path || '';
			}
			scroller.appendChild(rh);

			const list = (isCurrent
				? sessions.filter((s) => s.messages.length > 0)
				: repo.sessions || []
			).filter((s) => !q || (s.title || '').toLowerCase().includes(q));
			if (isCurrent && !list.length) {
				scroller.appendChild(el('div', 'rail-empty', q ? 'No matches' : 'No agents yet'));
			}
			for (const s of list) {
				shownAny = true;
				const isActive = isCurrent && s.id === active && view === 'chat';
				const row = el('div', 'rail-sess' + (isActive ? ' active' : ''));
				row.appendChild(el('span', 'rs-title', s.title || 'Agent'));
				row.appendChild(el('span', 'rs-age', age(s.updatedAt)));
				if (isCurrent) {
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
				} else {
					row.title = 'Open ' + repo.name;
					row.onclick = () => vscode.postMessage({ type: 'openRepoFolder', path: repo.path });
				}
				scroller.appendChild(row);
			}
		}
		void shownAny;
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

	// Bundled theme palettes for the preview cards (mirrors openova-themes).
	const THEMES = [
		{ name: 'Openova Dark', tb: '#17171d', sb: '#1b1b22', ed: '#141419', btn: '#7c6cf0', fg: '#e8e8ee', line: '#2c2c38' },
		{ name: 'Openova Midnight', tb: '#0b0e1a', sb: '#0e1220', ed: '#090c16', btn: '#2f6fe0', fg: '#dfe4f2', line: '#1d2438' },
		{ name: 'Openova Light', tb: '#f4f3f8', sb: '#f8f7fb', ed: '#ffffff', btn: '#6a5ae0', fg: '#2a2a33', line: '#e2e0ec' },
		{ name: 'Openova Nebula', tb: '#191122', sb: '#1e1529', ed: '#140e1c', btn: '#a06bff', fg: '#e4dcf2', line: '#332347' },
		{ name: 'Openova Ocean', tb: '#0d181c', sb: '#101d22', ed: '#0a1418', btn: '#14b8a6', fg: '#d8e8e8', line: '#1e343c' },
		{ name: 'Openova Forest', tb: '#101711', sb: '#131b14', ed: '#0c120d', btn: '#3fb950', fg: '#d9e5da', line: '#263628' },
		{ name: 'Openova Ember', tb: '#1b1512', sb: '#201915', ed: '#16110e', btn: '#f2762b', fg: '#ece2d8', line: '#3b2d23' },
		// allow-any-unicode-next-line
		{ name: 'Openova Rosé', tb: '#1c1219', sb: '#22161e', ed: '#150d12', btn: '#ec4899', fg: '#f0dce6', line: '#3d2532' },
		{ name: 'Openova Graphite', tb: '#161616', sb: '#1a1a1a', ed: '#111111', btn: '#6e7681', fg: '#e0e0e0', line: '#2e2e2e' }
	];

	function renderCustomize(main) {
		const pane = el('div', 'custz');
		const col = el('div', 'custz-col');
		col.appendChild(el('div', 'autom-title', 'Customize'));
		col.appendChild(
			el('div', 'autom-sub', 'Pick a look for the editor and the Agents window — everything follows the theme.')
		);

		const grid = el('div', 'theme-grid');
		for (const t of THEMES) {
			const card = el('div', 'theme-card' + (currentTheme === t.name ? ' active' : ''));
			// mini window mockup drawn from the theme palette
			const prev = el('div', 'tp');
			prev.style.background = t.ed;
			const bar = el('div', 'tp-bar');
			bar.style.background = t.tb;
			for (let i = 0; i < 3; i++) {
				const dot = el('span', 'tp-dot');
				dot.style.background = t.line;
				bar.appendChild(dot);
			}
			const pill = el('span', 'tp-pill');
			pill.style.background = t.btn;
			bar.appendChild(pill);
			prev.appendChild(bar);
			const body = el('div', 'tp-body');
			const side = el('div', 'tp-side');
			side.style.background = t.sb;
			for (let i = 0; i < 4; i++) {
				const r = el('div', 'tp-srow');
				r.style.background = t.line;
				side.appendChild(r);
			}
			body.appendChild(side);
			const edit = el('div', 'tp-edit');
			const widths = [72, 46, 60, 30, 54];
			widths.forEach((w, i) => {
				const r = el('div', 'tp-code');
				r.style.width = w + '%';
				r.style.background = i === 0 ? t.btn : t.line;
				edit.appendChild(r);
			});
			body.appendChild(edit);
			prev.appendChild(body);
			card.appendChild(prev);
			const foot = el('div', 'theme-foot');
			foot.appendChild(el('span', 'theme-name', t.name));
			if (currentTheme === t.name) {
				foot.appendChild(el('span', 'theme-active', 'Active'));
			}
			card.appendChild(foot);
			card.onclick = () => {
				currentTheme = t.name;
				vscode.postMessage({ type: 'applyTheme', name: t.name });
				render();
			};
			grid.appendChild(card);
		}
		col.appendChild(grid);

		const browse = el('button', 'theme-browse', 'Browse all installed themes…');
		browse.onclick = () => vscode.postMessage({ type: 'browseThemes' });
		col.appendChild(browse);
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
						box.appendChild(rc);
					}
				}
				if (m.steps && m.steps.length) {
					const isLast = m.role === 'assistant' && mi === sess.messages.length - 1;
					const isLive = (running && isLast) || !!m.pendingQuestion || m.paused !== undefined;
					box.appendChild(renderWork(m, isLive));
				}
				if (m.plan) {
					box.appendChild(renderPlan(m));
				}
				if (m.pendingQuestion) {
					box.appendChild(renderQuestion(m.pendingQuestion));
				}
				if (m.paused !== undefined) {
					const pb = el('div', 'pausedbar');
					pb.appendChild(
						el('span', 'pb-text', 'Paused after ' + m.paused + ' steps — the task isn\'t finished yet.')
					);
					const go = el('button', 'pb-continue', 'Continue');
					go.onclick = () => vscode.postMessage({ type: 'continueRun', sessionId: active });
					pb.appendChild(go);
					const stop = el('button', 'pb-stop', 'Stop here');
					stop.onclick = () => vscode.postMessage({ type: 'abort', sessionId: active });
					pb.appendChild(stop);
					box.appendChild(pb);
				}
				if (m.id === liveMsgId && liveText) {
					box.appendChild(el('div', 'live', liveText));
				}
				if (running && m.role === 'assistant' && mi === sess.messages.length - 1 && !m.pendingQuestion && m.paused === undefined) {
					const act = el('div', 'activity');
					act.appendChild(el('span', 'spin'));
					act.appendChild(el('span', 'activity-status', (activity && activity.status) || 'Working'));
					act.appendChild(el('span', 'activity-meta', activityMeta()));
					box.appendChild(act);
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
		const mh = el('div', 'pane-head mod-head');
		mh.appendChild(el('span', '', pickerLoading ? 'Model (discovering…)' : 'Model'));
		if (pickerNeedsKey && !pickerLoading) {
			// allow-any-unicode-next-line
			const kb = el('button', 'keybtn', pickerHasKey ? 'API key ✓' : 'Set API key…');
			kb.title = pickerHasKey ? 'Change or clear the stored API key' : 'Store an API key (encrypted)';
			kb.onclick = () => vscode.postMessage({ type: 'setApiKey', provider: pickerProvider });
			mh.appendChild(kb);
		}
		modPane.appendChild(mh);
		const list = el('div', 'mod-list');
		if (!pickerModels.length && !pickerLoading) {
			if (pickerLocal) {
				list.appendChild(
					el(
						'div',
						'mod-empty',
						'Can\'t reach the local server' + (pickerBaseURL ? ' at ' + pickerBaseURL : '') + '.'
					)
				);
				const hint =
					pickerProvider === 'lmstudio'
						// allow-any-unicode-next-line
						? 'Openova tried to start LM Studio\'s server automatically but couldn\'t reach it. Open LM Studio once (it installs the `lms` CLI), or start it manually: Developer → Start Server.'
						: pickerProvider === 'ollama'
							? 'Start Ollama (`ollama serve`) and pull a model (`ollama pull qwen3.5:9b`).'
							: 'Make sure the server is running and the base URL is right.';
				list.appendChild(el('div', 'mod-hint', hint));
				if (pickerError) { list.appendChild(el('div', 'mod-err', pickerError)); }
			} else if (pickerNeedsKey && !pickerHasKey) {
				list.appendChild(el('div', 'mod-empty', 'This provider needs an API key.'));
				const add = el('button', 'mod-addkey', 'Add API key');
				add.onclick = () => vscode.postMessage({ type: 'setApiKey', provider: pickerProvider });
				list.appendChild(add);
			} else {
				list.appendChild(el('div', 'mod-empty', 'No models found' + (pickerError ? ' — ' + pickerError : '')));
			}
		}
		if (pickerModels.length && !pickerDiscovered && !pickerLoading && !pickerLocal) {
			list.appendChild(
				el('div', 'mod-hint', 'Suggested models (live discovery unavailable' + (pickerError ? ': ' + pickerError : '') + ')')
			);
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
		const perm = el('div', 'effort');
		perm.appendChild(el('span', 'pane-head', 'Commands'));
		const pseg = el('div', 'seg');
		for (const [v, label] of [['ask', 'Ask first'], ['auto', 'Auto-run']]) {
			const b = el('button', (settings.permissionMode || 'ask') === v ? 'active' : '', label);
			b.title =
				v === 'auto'
					? 'Bypass permission prompts — the agent runs terminal commands without asking'
					: 'Ask before running commands the safety gate doesn\'t auto-allow';
			b.onclick = () => vscode.postMessage({ type: 'setSettings', patch: { permissionMode: v } });
			pseg.appendChild(b);
		}
		perm.appendChild(pseg);
		panel.appendChild(perm);
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
			approve.onclick = () => vscode.postMessage({ type: 'planApprove', sessionId: active, msgId: m.id });
			actions.appendChild(approve);
			card.appendChild(actions);
		}
		return card;
	}

	function renderQuestion(q) {
		const card = el('div', 'qcard');
		card.appendChild(el('div', 'q-head', 'Question'));
		card.appendChild(el('div', 'q-text', q.question));
		const answer = (a) => vscode.postMessage({ type: 'answerQuestion', qid: q.qid, answer: a });
		const opts = el('div', 'q-opts');
		const LETTERS = 'ABCDEF';
		q.options.forEach(function (opt, i) {
			const row = el('button', 'q-opt');
			row.appendChild(el('span', 'q-letter', LETTERS[i] || String(i + 1)));
			row.appendChild(el('span', 'q-opt-text', opt));
			row.onclick = () => answer(opt);
			opts.appendChild(row);
		});
		card.appendChild(opts);
		const foot = el('div', 'q-foot');
		const other = document.createElement('input');
		other.className = 'q-other';
		other.placeholder = 'Or type your own answer…';
		other.onkeydown = (e) => {
			if (e.key === 'Enter' && other.value.trim()) { answer(other.value.trim()); }
		};
		foot.appendChild(other);
		const skip = el('button', 'q-skip', 'Skip');
		skip.title = 'Let the agent decide';
		skip.onclick = () => answer('(skipped — use your best judgment)');
		foot.appendChild(skip);
		card.appendChild(foot);
		return card;
	}

	// ---- Cursor-style work section: prose narration + quiet grouped rows ----
	const expandedWork = new Set();
	const expandedGroups = new Set();
	const expandedSteps = new Set();

	function activityMeta() {
		const bits = [];
		if (activity && activity.chars > 400) {
			bits.push((activity.chars / 1000).toFixed(1) + 'k chars');
		}
		if (runStartLocal) {
			const s = Math.floor((Date.now() - runStartLocal) / 1000);
			bits.push(s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's');
		}
		// allow-any-unicode-next-line
		return bits.length ? '· ' + bits.join(' · ') : '';
	}

	function fmtDuration(ms) {
		if (!ms || ms < 1000) { return ''; }
		const s = Math.round(ms / 1000);
		if (s < 60) { return s + 's'; }
		return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
	}

	function dedupSteps(steps) {
		const out = [];
		let i = 0;
		while (i < steps.length) {
			let j = i + 1;
			while (j < steps.length && steps[j].title === steps[i].title) { j++; }
			out.push({ st: steps[j - 1], count: j - i });
			i = j;
		}
		return out;
	}

	const EXPLORE_KINDS = { list_files: 1, read_file: 1, search: 1, codebase_search: 1 };

	function renderWork(m, live) {
		const wrap = el('div', 'work');
		const expanded = live || expandedWork.has(m.id);
		if (!live) {
			const head = el('button', 'work-head');
			const dur = fmtDuration(m.durationMs);
			head.appendChild(el('span', '', dur ? 'Worked for ' + dur : 'Worked'));
			const chev = el('span', 'work-chev' + (expanded ? ' open' : ''));
			chev.appendChild(icon(ICONS.chevron, 11));
			head.appendChild(chev);
			head.onclick = () => {
				if (expandedWork.has(m.id)) { expandedWork.delete(m.id); }
				else { expandedWork.add(m.id); }
				render();
			};
			wrap.appendChild(head);
			if (!expanded) { return wrap; }
		}
		const body = el('div', 'work-body');
		const dedup = dedupSteps(m.steps);
		let gi = 0;
		let k = 0;
		while (k < dedup.length) {
			const st = dedup[k].st;
			if (st.kind === 'thought') {
				const p = el('div', 'work-prose');
				mdInline(p, st.title);
				body.appendChild(p);
				k++;
			} else if (EXPLORE_KINDS[st.kind] && st.status !== 'running') {
				const group = [];
				while (
					k < dedup.length &&
					EXPLORE_KINDS[dedup[k].st.kind] &&
					dedup[k].st.status !== 'running'
				) {
					group.push(dedup[k]);
					k++;
				}
				body.appendChild(renderExploreGroup(m.id, gi++, group));
			} else {
				body.appendChild(renderActionRow(m, st, dedup[k].count));
				k++;
			}
		}
		wrap.appendChild(body);
		return wrap;
	}

	function renderExploreGroup(msgId, gi, group) {
		const key = msgId + ':' + gi;
		const wrap = el('div', 'explore');
		const files = new Set();
		let searches = 0;
		let listed = false;
		for (const g of group) {
			if (g.st.kind === 'read_file') { files.add(g.st.title); }
			else if (g.st.kind === 'list_files') { listed = true; }
			else { searches++; }
		}
		const bits = [];
		if (files.size) { bits.push(files.size + ' file' + (files.size === 1 ? '' : 's')); }
		if (searches) { bits.push(searches + ' search' + (searches === 1 ? '' : 'es')); }
		if (!bits.length && listed) { bits.push('the workspace'); }
		const isOpen = expandedGroups.has(key);
		const head = el('button', 'explore-head');
		head.appendChild(el('span', '', 'Explored ' + bits.join(', ')));
		const chev = el('span', 'work-chev' + (isOpen ? ' open' : ''));
		chev.appendChild(icon(ICONS.chevron, 10));
		head.appendChild(chev);
		head.onclick = () => {
			if (expandedGroups.has(key)) { expandedGroups.delete(key); }
			else { expandedGroups.add(key); }
			render();
		};
		wrap.appendChild(head);
		if (isOpen) {
			const list = el('div', 'explore-list');
			for (const g of group) { list.appendChild(renderActionRow(null, g.st, g.count)); }
			wrap.appendChild(list);
		}
		return wrap;
	}

	function renderActionRow(m, st, count) {
		const open = expandedSteps.has(st.id);
		const toggle = () => {
			if (!st.detail) { return; }
			if (expandedSteps.has(st.id)) { expandedSteps.delete(st.id); }
			else { expandedSteps.add(st.id); }
			render();
		};
		if (st.kind === 'run_command' || st.kind === 'check') {
			const row = el('div', 'cmd' + (st.status === 'error' ? ' err' : ''));
			const head = el('button', 'cmd-head');
			head.appendChild(el('span', 'cmd-label', st.kind === 'check' ? 'Checked' : 'Ran'));
			head.appendChild(el('code', 'cmd-text', st.title.replace(/^\$\s*/, '')));
			if (st.status === 'running') { head.appendChild(el('span', 'spin')); }
			if (st.detail) {
				const chev = el('span', 'work-chev' + (open ? ' open' : ''));
				chev.appendChild(icon(ICONS.chevron, 10));
				head.appendChild(chev);
			}
			head.onclick = toggle;
			row.appendChild(head);
			if (open && st.detail) {
				const out = el('pre', 'cmd-out');
				out.textContent = st.detail;
				row.appendChild(out);
			}
			return row;
		}
		// compact quiet line for everything else
		const row = el('div', 'wl' + (st.status === 'error' ? ' err' : '') + (st.detail ? ' has-detail' : ''));
		const line = el('button', 'wl-line');
		if (st.status === 'running') {
			line.appendChild(el('span', 'spin'));
		}
		let label = st.title;
		if (st.kind === 'write_file') {
			label = st.title.replace(/^Edited /, '');
			line.appendChild(el('span', 'wl-verb', 'Edited'));
		} else if (st.kind === 'read_file') {
			label = st.title.replace(/^Read /, '');
			line.appendChild(el('span', 'wl-verb', 'Read'));
		} else if (st.kind === 'finish') {
			line.appendChild(el('span', 'wl-verb', 'Done'));
		}
		line.appendChild(el('span', 'wl-text', label));
		if (st.kind === 'write_file' && m && m.writes) {
			const w = m.writes.find((x) => x.path === label);
			if (w) {
				if (w.added) { line.appendChild(el('span', 'radd', '+' + w.added)); }
				if (w.removed) { line.appendChild(el('span', 'rdel', '-' + w.removed)); }
			}
		}
		if (count > 1) {
			// allow-any-unicode-next-line
			line.appendChild(el('span', 'xn', '×' + count));
		}
		if (st.kind === 'write_file') {
			// edited-file rows open the file in the Editor pane
			row.classList.add('has-detail');
			line.title = 'Open ' + label;
			line.onclick = () => openInternalFile(label);
		} else {
			line.onclick = toggle;
		}
		row.appendChild(line);
		if (open && st.detail) {
			const d = el('pre', 'cmd-out');
			d.textContent = st.detail;
			row.appendChild(d);
		}
		return row;
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

	function applyView(v) {
		if (!v) { return; }
		if (v.indexOf('picker:') === 0) {
			// dev-harness hook: open the model picker on a provider
			pickerOpen = true;
			pickerProvider = v.slice(7);
			pickerModels = [];
			pickerLoading = true;
			vscode.postMessage({ type: 'listModels', provider: pickerProvider });
		} else if (v.indexOf('tool:') === 0) {
			toolView = v.slice(5);
			view = 'chat';
			if (toolView === 'terminal' && !termStarted) {
				termStarted = true;
				vscode.postMessage({ type: 'termStart' });
			}
		} else {
			view = v;
		}
	}

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
				repos = m.repos || [];
				repoCurrent = m.repoCurrent || null;
				currentTheme = m.theme || '';
				if (m.view) { applyView(m.view); }
				render();
				break;
			case 'showView':
				applyView(m.view);
				render();
				break;
			case 'automations':
				automations = m.items || [];
				render();
				break;
			case 'repos':
				repos = m.repos || [];
				repoCurrent = m.repoCurrent || null;
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
					pickerError = m.error || null;
					pickerNeedsKey = !!m.needsKey;
					pickerHasKey = !!m.hasKey;
					pickerLocal = !!m.local;
					pickerBaseURL = m.baseURL || '';
					pickerDiscovered = !!m.discovered;
					const pv = providers.find((p) => p.id === m.provider);
					if (pv) { pv.hasKey = !!m.hasKey; }
				}
				render();
				break;
			case 'theme':
				currentTheme = m.current || '';
				render();
				break;
			case 'agentWrote':
				if (!sessionFiles.includes(m.path)) { sessionFiles.unshift(m.path); }
				if (isWindow && toolView === 'files' && followAgent) {
					currentFile = m.path;
					fileContent = m.content || '';
					render();
				} else if (currentFile === m.path) {
					fileContent = m.content || '';
					render();
				}
				break;
			case 'fileContent':
				if (m.path === currentFile) {
					fileContent = m.content || '';
					render();
				}
				break;
			case 'termData': {
				termBuffer = (termBuffer + (m.data || '')).slice(-200000);
				const outEl = document.querySelector('.tool-term');
				if (outEl) {
					outEl.textContent = termBuffer;
					outEl.scrollTop = outEl.scrollHeight;
				}
				break;
			}
			case 'workspaceFiles': {
				wsFiles = m.files || [];
				const ta = document.querySelector('.composer textarea');
				if (ta) { renderMention(ta); }
				break;
			}
			case 'running':
				running = m.running;
				if (m.running) {
					runStartLocal = Date.now();
					if (!activityTimer) {
						activityTimer = setInterval(() => {
							const meta = document.querySelector('.activity-meta');
							if (meta) { meta.textContent = activityMeta(); }
						}, 1000);
					}
				} else {
					liveText = '';
					liveMsgId = null;
					activity = null;
					runStartLocal = 0;
					if (activityTimer) {
						clearInterval(activityTimer);
						activityTimer = null;
					}
				}
				render();
				break;
			case 'activity': {
				activity = { status: m.status, chars: m.chars || 0 };
				const s = document.querySelector('.activity-status');
				if (s) {
					// allow-any-unicode-next-line
					s.textContent = m.status + '…';
					const meta = document.querySelector('.activity-meta');
					if (meta) { meta.textContent = activityMeta(); }
				} else {
					render();
				}
				break;
			}
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
