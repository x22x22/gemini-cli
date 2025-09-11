/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SemanticColors } from './semantic-tokens.js';
import { type ColorsTheme, Theme } from './theme.js';

const draculaColors: ColorsTheme = {
  type: 'dark',
  Background: '#282a36',
  Foreground: '#f8f8f2',
  LightBlue: '#8be9fd',
  AccentBlue: '#8be9fd',
  AccentPurple: '#ff79c6',
  AccentCyan: '#8be9fd',
  AccentGreen: '#50fa7b',
  AccentYellow: '#f1fa8c',
  AccentRed: '#ff5555',
  DiffAdded: '#11431d',
  DiffRemoved: '#6e1818',
  Comment: '#6272a4',
  Gray: '#6272a4',
  GradientColors: ['#ff79c6', '#8be9fd'],
};

const draculaSemanticColors: SemanticColors = {
  text: {
    primary: draculaColors.Foreground,
    secondary: draculaColors.Gray,
    link: draculaColors.AccentBlue,
    accent: draculaColors.AccentPurple,
  },
  background: {
    primary: draculaColors.Background,
    diff: {
      added: draculaColors.DiffAdded,
      removed: draculaColors.DiffRemoved,
    },
  },
  border: {
    default: draculaColors.Gray,
    focused: draculaColors.AccentPurple,
  },
  ui: {
    comment: draculaColors.Comment,
    symbol: draculaColors.AccentCyan,
    gradient: draculaColors.GradientColors,
  },
  status: {
    error: draculaColors.AccentRed,
    success: draculaColors.AccentGreen,
    warning: draculaColors.AccentYellow,
  },
};

export const Dracula: Theme = new Theme(
  'Dracula',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: draculaColors.Background,
      color: draculaColors.Foreground,
    },
    'hljs-keyword': {
      color: draculaColors.AccentBlue,
      fontWeight: 'bold',
    },
    'hljs-selector-tag': {
      color: draculaColors.AccentBlue,
      fontWeight: 'bold',
    },
    'hljs-literal': {
      color: draculaColors.AccentBlue,
      fontWeight: 'bold',
    },
    'hljs-section': {
      color: draculaColors.AccentBlue,
      fontWeight: 'bold',
    },
    'hljs-link': {
      color: draculaColors.AccentBlue,
    },
    'hljs-function .hljs-keyword': {
      color: draculaColors.AccentPurple,
    },
    'hljs-subst': {
      color: draculaColors.Foreground,
    },
    'hljs-string': {
      color: draculaColors.AccentYellow,
    },
    'hljs-title': {
      color: draculaColors.AccentYellow,
      fontWeight: 'bold',
    },
    'hljs-name': {
      color: draculaColors.AccentYellow,
      fontWeight: 'bold',
    },
    'hljs-type': {
      color: draculaColors.AccentYellow,
      fontWeight: 'bold',
    },
    'hljs-attribute': {
      color: draculaColors.AccentYellow,
    },
    'hljs-symbol': {
      color: draculaColors.AccentYellow,
    },
    'hljs-bullet': {
      color: draculaColors.AccentYellow,
    },
    'hljs-addition': {
      color: draculaColors.AccentGreen,
    },
    'hljs-variable': {
      color: draculaColors.AccentYellow,
    },
    'hljs-template-tag': {
      color: draculaColors.AccentYellow,
    },
    'hljs-template-variable': {
      color: draculaColors.AccentYellow,
    },
    'hljs-comment': {
      color: draculaColors.Comment,
    },
    'hljs-quote': {
      color: draculaColors.Comment,
    },
    'hljs-deletion': {
      color: draculaColors.AccentRed,
    },
    'hljs-meta': {
      color: draculaColors.Comment,
    },
    'hljs-doctag': {
      fontWeight: 'bold',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
  },
  draculaColors,
  draculaSemanticColors,
);
