/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FunctionCall } from '@google/genai';
import {
  PolicyDecision,
  type PolicyEngineConfig,
  type PolicyRule,
} from './types.js';

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly defaultDecision: PolicyDecision;
  private readonly nonInteractive: boolean;

  constructor(config: PolicyEngineConfig = {}) {
    this.rules = (config.rules ?? []).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    this.defaultDecision = config.defaultDecision ?? PolicyDecision.ASK_USER;
    this.nonInteractive = config.nonInteractive ?? false;
  }

  /**
   * Check if a tool call is allowed based on the configured policies.
   */
  check(toolCall: FunctionCall): PolicyDecision {
    // Find the first matching rule (already sorted by priority)
    for (const rule of this.rules) {
      if (this.ruleMatches(rule, toolCall)) {
        return this.applyNonInteractiveMode(rule.decision);
      }
    }

    // No matching rule found, use default decision
    return this.applyNonInteractiveMode(this.defaultDecision);
  }

  /**
   * Add a new rule to the policy engine.
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    // Re-sort rules by priority
    this.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Remove rules for a specific tool.
   */
  removeRulesForTool(toolName: string): void {
    // Remove all rules for the specified tool, not just the first one
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i].toolName === toolName) {
        this.rules.splice(i, 1);
      }
    }
  }

  /**
   * Get all current rules.
   */
  getRules(): readonly PolicyRule[] {
    return this.rules;
  }

  private ruleMatches(rule: PolicyRule, toolCall: FunctionCall): boolean {
    // Check tool name if specified
    if (rule.toolName && toolCall.name !== rule.toolName) {
      return false;
    }

    // Check args pattern if specified
    if (rule.argsPattern) {
      // If rule has an args pattern but tool has no args, no match
      if (!toolCall.args) {
        return false;
      }
      // Use stable JSON stringification with sorted keys to ensure consistent matching
      const argsString = this.stableStringify(toolCall.args);
      if (!rule.argsPattern.test(argsString)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Produces a stable JSON string representation with sorted keys.
   * This ensures consistent pattern matching regardless of property order.
   */
  private stableStringify(obj: unknown): string {
    if (obj === null || obj === undefined) {
      return JSON.stringify(obj);
    }
    
    if (typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.stableStringify(item)).join(',') + ']';
    }
    
    // Sort object keys and recursively stringify
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map(key => {
      const value = (obj as Record<string, unknown>)[key];
      return JSON.stringify(key) + ':' + this.stableStringify(value);
    });
    return '{' + pairs.join(',') + '}';
  }

  private applyNonInteractiveMode(decision: PolicyDecision): PolicyDecision {
    // In non-interactive mode, ASK_USER becomes DENY
    if (this.nonInteractive && decision === PolicyDecision.ASK_USER) {
      return PolicyDecision.DENY;
    }
    return decision;
  }
}
