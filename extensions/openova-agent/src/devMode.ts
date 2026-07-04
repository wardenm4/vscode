/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Headless-harness scoping. The OPENOVA_DEV_TRIGGER env var stays set for the
// whole process lifetime, but harness behavior (auto-approve plans, auto-answer
// questions, auto-deny command prompts) must apply ONLY to the run the trigger
// itself started — a user typing into the same instance gets normal behavior.
let devRunActive = false;

export function setDevRunActive(v: boolean): void {
	devRunActive = v;
}

export function isDevRunActive(): boolean {
	return devRunActive;
}
