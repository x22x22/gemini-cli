/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { theme } from './semantic-colors.js';
import { themeManager } from './themes/theme-manager.js';

export const Colors = {
  get type() {
    return themeManager.getActiveTheme().colors.type;
  },
  get Foreground() {
    return theme.text.primary;
  },
  get Background() {
    return theme.background.primary;
  },
  get LightBlue() {
    return themeManager.getActiveTheme().colors.LightBlue;
  },
  get AccentBlue() {
    return theme.text.link;
  },
  get AccentPurple() {
    return theme.text.accent;
  },
  get AccentCyan() {
    return themeManager.getActiveTheme().colors.AccentCyan;
  },
  get AccentGreen() {
    return theme.status.success;
  },
  get AccentYellow() {
    return theme.status.warning;
  },
  get AccentRed() {
    return theme.status.error;
  },
  get DiffAdded() {
    return theme.background.diff.added;
  },
  get DiffRemoved() {
    return theme.background.diff.removed;
  },
  get Comment() {
    return theme.ui.comment;
  },
  get Gray() {
    return theme.text.secondary;
  },
  get GradientColors() {
    return theme.ui.gradient;
  },
};
