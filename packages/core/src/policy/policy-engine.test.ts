/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine } from './policy-engine.js';
import {
  PolicyDecision,
  type PolicyRule,
  type PolicyEngineConfig,
} from './types.js';
import type { FunctionCall } from '@google/genai';

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const decision = engine.check({ name: 'test' });
      expect(decision).toBe(PolicyDecision.ASK_USER);
    });

    it('should respect custom default decision', () => {
      engine = new PolicyEngine({ defaultDecision: PolicyDecision.DENY });
      const decision = engine.check({ name: 'test' });
      expect(decision).toBe(PolicyDecision.DENY);
    });

    it('should sort rules by priority', () => {
      const rules: PolicyRule[] = [
        { toolName: 'tool1', decision: PolicyDecision.DENY, priority: 1 },
        { toolName: 'tool2', decision: PolicyDecision.ALLOW, priority: 10 },
        { toolName: 'tool3', decision: PolicyDecision.ASK_USER, priority: 5 },
      ];

      engine = new PolicyEngine({ rules });
      const sortedRules = engine.getRules();

      expect(sortedRules[0].priority).toBe(10);
      expect(sortedRules[1].priority).toBe(5);
      expect(sortedRules[2].priority).toBe(1);
    });
  });

  describe('check', () => {
    it('should match tool by name', () => {
      const rules: PolicyRule[] = [
        { toolName: 'shell', decision: PolicyDecision.ALLOW },
        { toolName: 'edit', decision: PolicyDecision.DENY },
      ];

      engine = new PolicyEngine({ rules });

      expect(engine.check({ name: 'shell' })).toBe(PolicyDecision.ALLOW);
      expect(engine.check({ name: 'edit' })).toBe(PolicyDecision.DENY);
      expect(engine.check({ name: 'other' })).toBe(PolicyDecision.ASK_USER);
    });

    it('should match by args pattern', () => {
      const rules: PolicyRule[] = [
        {
          toolName: 'shell',
          argsPattern: /rm -rf/,
          decision: PolicyDecision.DENY,
        },
        {
          toolName: 'shell',
          decision: PolicyDecision.ALLOW,
        },
      ];

      engine = new PolicyEngine({ rules });

      const dangerousCall: FunctionCall = {
        name: 'shell',
        args: { command: 'rm -rf /' },
      };

      const safeCall: FunctionCall = {
        name: 'shell',
        args: { command: 'ls -la' },
      };

      expect(engine.check(dangerousCall)).toBe(PolicyDecision.DENY);
      expect(engine.check(safeCall)).toBe(PolicyDecision.ALLOW);
    });

    it('should apply rules by priority', () => {
      const rules: PolicyRule[] = [
        { toolName: 'shell', decision: PolicyDecision.DENY, priority: 1 },
        { toolName: 'shell', decision: PolicyDecision.ALLOW, priority: 10 },
      ];

      engine = new PolicyEngine({ rules });

      // Higher priority rule (ALLOW) should win
      expect(engine.check({ name: 'shell' })).toBe(PolicyDecision.ALLOW);
    });

    it('should apply wildcard rules (no toolName)', () => {
      const rules: PolicyRule[] = [
        { decision: PolicyDecision.DENY }, // Applies to all tools
        { toolName: 'safe-tool', decision: PolicyDecision.ALLOW, priority: 10 },
      ];

      engine = new PolicyEngine({ rules });

      expect(engine.check({ name: 'safe-tool' })).toBe(PolicyDecision.ALLOW);
      expect(engine.check({ name: 'any-other-tool' })).toBe(
        PolicyDecision.DENY,
      );
    });

    it('should handle non-interactive mode', () => {
      const config: PolicyEngineConfig = {
        nonInteractive: true,
        rules: [
          { toolName: 'interactive-tool', decision: PolicyDecision.ASK_USER },
          { toolName: 'allowed-tool', decision: PolicyDecision.ALLOW },
        ],
      };

      engine = new PolicyEngine(config);

      // ASK_USER should become DENY in non-interactive mode
      expect(engine.check({ name: 'interactive-tool' })).toBe(
        PolicyDecision.DENY,
      );
      // ALLOW should remain ALLOW
      expect(engine.check({ name: 'allowed-tool' })).toBe(PolicyDecision.ALLOW);
      // Default ASK_USER should also become DENY
      expect(engine.check({ name: 'unknown-tool' })).toBe(PolicyDecision.DENY);
    });
  });

  describe('addRule', () => {
    it('should add a new rule and maintain priority order', () => {
      engine.addRule({
        toolName: 'tool1',
        decision: PolicyDecision.ALLOW,
        priority: 5,
      });
      engine.addRule({
        toolName: 'tool2',
        decision: PolicyDecision.DENY,
        priority: 10,
      });
      engine.addRule({
        toolName: 'tool3',
        decision: PolicyDecision.ASK_USER,
        priority: 1,
      });

      const rules = engine.getRules();
      expect(rules).toHaveLength(3);
      expect(rules[0].priority).toBe(10);
      expect(rules[1].priority).toBe(5);
      expect(rules[2].priority).toBe(1);
    });

    it('should apply newly added rules', () => {
      expect(engine.check({ name: 'new-tool' })).toBe(PolicyDecision.ASK_USER);

      engine.addRule({ toolName: 'new-tool', decision: PolicyDecision.ALLOW });

      expect(engine.check({ name: 'new-tool' })).toBe(PolicyDecision.ALLOW);
    });
  });

  describe('removeRulesForTool', () => {
    it('should remove rules for specific tool', () => {
      engine.addRule({ toolName: 'tool1', decision: PolicyDecision.ALLOW });
      engine.addRule({ toolName: 'tool2', decision: PolicyDecision.DENY });
      engine.addRule({
        toolName: 'tool1',
        decision: PolicyDecision.ASK_USER,
        priority: 10,
      });

      expect(engine.getRules()).toHaveLength(3);

      engine.removeRulesForTool('tool1');

      const remainingRules = engine.getRules();
      expect(remainingRules).toHaveLength(1);
      expect(remainingRules.some((r) => r.toolName === 'tool1')).toBe(false);
      expect(remainingRules.some((r) => r.toolName === 'tool2')).toBe(true);
    });

    it('should handle removing non-existent tool', () => {
      engine.addRule({ toolName: 'existing', decision: PolicyDecision.ALLOW });

      expect(() => engine.removeRulesForTool('non-existent')).not.toThrow();
      expect(engine.getRules()).toHaveLength(1);
    });
  });

  describe('getRules', () => {
    it('should return readonly array of rules', () => {
      const rules: PolicyRule[] = [
        { toolName: 'tool1', decision: PolicyDecision.ALLOW },
        { toolName: 'tool2', decision: PolicyDecision.DENY },
      ];

      engine = new PolicyEngine({ rules });

      const retrievedRules = engine.getRules();
      expect(retrievedRules).toHaveLength(2);
      expect(retrievedRules[0].toolName).toBe('tool1');
      expect(retrievedRules[1].toolName).toBe('tool2');
    });
  });

  describe('complex scenarios', () => {
    it('should handle multiple matching rules with different priorities', () => {
      const rules: PolicyRule[] = [
        { decision: PolicyDecision.DENY, priority: 0 }, // Default deny all
        { toolName: 'shell', decision: PolicyDecision.ASK_USER, priority: 5 },
        {
          toolName: 'shell',
          argsPattern: /"command":"ls/,
          decision: PolicyDecision.ALLOW,
          priority: 10,
        },
      ];

      engine = new PolicyEngine({ rules });

      // Matches highest priority rule (ls command)
      expect(engine.check({ name: 'shell', args: { command: 'ls -la' } })).toBe(
        PolicyDecision.ALLOW,
      );

      // Matches middle priority rule (shell without ls)
      expect(engine.check({ name: 'shell', args: { command: 'pwd' } })).toBe(
        PolicyDecision.ASK_USER,
      );

      // Matches lowest priority rule (not shell)
      expect(engine.check({ name: 'edit' })).toBe(PolicyDecision.DENY);
    });

    it('should handle tools with no args', () => {
      const rules: PolicyRule[] = [
        {
          toolName: 'read',
          argsPattern: /secret/,
          decision: PolicyDecision.DENY,
        },
      ];

      engine = new PolicyEngine({ rules });

      // Tool call without args should not match pattern
      expect(engine.check({ name: 'read' })).toBe(PolicyDecision.ASK_USER);

      // Tool call with args not matching pattern
      expect(engine.check({ name: 'read', args: { file: 'public.txt' } })).toBe(
        PolicyDecision.ASK_USER,
      );

      // Tool call with args matching pattern
      expect(engine.check({ name: 'read', args: { file: 'secret.txt' } })).toBe(
        PolicyDecision.DENY,
      );
    });
  });
});
