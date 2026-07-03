/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Openova core contribution: the blue "Agents" title-bar button (Cursor-style)
// that opens the Openova Agents window provided by the openova-agent extension.
import './media/openova.css';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

const OPENOVA_AGENTS_TITLEBAR_COMMAND_ID = 'openova.titleBarAgents';

class OpenovaAgentsTitleBarAction extends Action2 {
	constructor() {
		super({
			id: OPENOVA_AGENTS_TITLEBAR_COMMAND_ID,
			title: localize2('openovaAgents', "Agents"),
			f1: false,
			menu: [{
				id: MenuId.TitleBar,
				group: TitleBarLeadingActionsGroup,
				order: -1000,
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('openova.openAgentsWindow');
	}
}

/** The blue Cursor-style pill: nova icon + persistent "Agents" label. */
class OpenovaAgentsTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('openova-agents-titlebar-widget');
		container.setAttribute('role', 'button');

		const hoverText = localize('openovaAgentsHover', "Open the Openova Agents window (Ctrl+Shift+A)");
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const icon = append(container, $('span.openova-agents-titlebar-widget-icon'));
		icon.setAttribute('aria-hidden', 'true');
		// allow-any-unicode-next-line
		icon.textContent = '✦';

		const labelEl = append(container, $('span.openova-agents-titlebar-widget-label'));
		labelEl.textContent = localize('openovaAgentsLabel', "Agents");
	}
}

class OpenovaTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openovaTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, OPENOVA_AGENTS_TITLEBAR_COMMAND_ID, (action, options) => {
			return instantiationService.createInstance(OpenovaAgentsTitleBarWidget, action, options);
		}, undefined));
	}
}

registerAction2(OpenovaAgentsTitleBarAction);
registerWorkbenchContribution2(OpenovaTitleBarContribution.ID, OpenovaTitleBarContribution, WorkbenchPhase.BlockRestore);
