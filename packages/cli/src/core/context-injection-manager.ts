/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import { GeminiClient } from '@google/gemini-cli-core';
import type { GenerateContentResponse } from '@google/genai';
import type { CIMOutput } from './reminder-types.js';
import { ReminderHook, TDDState } from './reminder-types.js';
import { TDDStateManager } from './tdd-state-manager.js';
import { StagnationDetector } from './stagnation-detector.js';
import { invokeGuardian } from './security-guardian.js';
import * as reminders from './reminder-factory.js';
import { cimConfig } from './cim.config.js';

// Configuration for the completion loop detector
const RESPONSE_HISTORY_BUFFER = 4;
const COMPLETION_LOOP_THRESHOLD = 2;

// Configuration for Quality Control
const MAX_CHANGE_SIZE_LINES = 30;
// Threshold for consecutive failures before forcing a strategy pivot
const ANTI_TUNNEL_VISION_THRESHOLD = 3;

export class ContextInjectionManager {
  private turnCount = 0;
  private lastErrorHash: string | null = null;
  private tddStateManager = new TDDStateManager();
  private stagnationDetector = new StagnationDetector();
  // Buffer to track recent model responses for loop detection
  private recentModelResponses: string[] = [];

  constructor(
    private readonly geminiClient: GeminiClient,
    private readonly config: Config,
  ) {}

  async processHook(hook: ReminderHook, payload: any): Promise<CIMOutput> {
    switch (hook) {
      case ReminderHook.StartOfTurn:
        return this._handleStartOfTurn(payload);
      case ReminderHook.PreToolExecution:
        return this._handlePreToolExecution(payload);
      case ReminderHook.PostToolExecution:
        return this._handlePostToolExecution(payload);
      case ReminderHook.PreResponseFinalization:
        return this._handlePreResponseFinalization(payload);
      default:
        return { reminders: [] };
    }
  }

  private _getResponseText(
    response: GenerateContentResponse,
  ): string | null {
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];

      if (
        candidate.content &&
        candidate.content.parts &&
        candidate.content.parts.length > 0
      ) {
        return candidate.content.parts
          .filter((part) => part.text)
          .map((part) => part.text)
          .join('');
      }
    }
    return null;
  }

  // Improved Error Hashing: Normalize workspace paths
  private _hashError(message: string): string {
    let normalized = message.toLowerCase();
    normalized = normalized.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '[TIMESTAMP]');
    normalized = normalized.replace(/\d{2}:\d{2}:\d{2}/g, '[TIME]');
    normalized = normalized.replace(/0x[0-9a-f]+/g, '[MEMORY_ADDRESS]');
    normalized = normalized.replace(/pid[:\s]\d+/g, 'pid:[PID]');
    // Normalize repository paths (e.g., /tmp/repo12345/...)
    normalized = normalized.replace(/\/tmp\/repo\d+\//g, '[WORKSPACE_ROOT]/');
    normalized = normalized.replace(/(\/[\w\-\\.]+)+/g, '[PATH]');
    return Buffer.from(normalized).toString('base64');
  }

  private async _handleStartOfTurn(payload: any): Promise<CIMOutput> {
    this.turnCount++;

    // Enforce initial planning on Turn 1.
    if (this.turnCount === 1) {
      const analysisMandate = `
    STOP. DO NOT USE ANY TOOLS YET.

    Your first action MUST be analysis and planning.

    1. **Analyze the Task:** Carefully review the task provided by the user.
    2. **Extract Keywords:** Identify critical function names, class names, error messages, or specific file paths mentioned.
    3. **Formulate Strategy:** Outline your initial exploration plan based *only* on these keywords. (e.g., "I will use 'grep -r [Keyword]' to locate the relevant module," or "I will examine [FilePath] mentioned in the report.")

    Respond with your analysis and strategy before executing any tools.
    `;
      return {
        reminders: [
          reminders.formatReminder(
            'MANDATORY: Initial Problem Analysis & Strategy',
            analysisMandate,
          ),
        ],
      };
    }

    const reminderList = reminders.getGlobalBehaviorReminders(this.config.getProjectRoot());
    const currentState = this.tddStateManager.getState();
    const stateGoal = reminders.getTDDStateGoal(currentState);
    reminderList.push(
      reminders.formatReminder(
        'Current Workflow Status',
        // Use getTDDStateName for clear string representation
        `State: ${reminders.getTDDStateName(currentState)}\nObjective: ${stateGoal}`,
      ),
    );

    if (currentState === TDDState.EXPLORING) {
      reminderList.push(reminders.getExplorationToolkitReminder());
      
      const strategyNudge = `
          Effective exploration requires understanding the architecture, not just reading files sequentially.

          ADVANCED STRATEGIES:
          1. **Trace Dependencies:** Use \`grep "import "\` in key files to see how modules connect.
          2. **Find Usages:** Use \`grep -r "<function_name>("\` or \`grep -r "<ClassName>"\` to see where critical components are used.
          3. **Analyze Structure:** Examine \`__init__.py\`, \`setup.py\`, or similar entry points to understand module organization and resolve potential import issues (like circular dependencies).

          Build a map of the system before attempting complex edits.
          `;
      reminderList.push(
        reminders.formatReminder(
          'STRATEGY: Deep Exploration Techniques',
          strategyNudge,
        ),
      );
    }

    // P3.3: Enhanced Cleanup & Quality Enforcement
    if (currentState >= TDDState.FIX_VERIFIED && this.tddStateManager.getModifiedFiles().size > 0) {
      const fileList = Array.from(this.tddStateManager.getModifiedFiles()).join('\n- ');
      const body = `
    The fix is verified. You MUST complete the CLEANUP phase.
    
    1. **Revert Temporary Tests:** Remove any test cases added solely for reproduction.
    2. **Remove Debug Code:** Delete ALL temporary logging (e.g., print statements, console.log).
    3. **QUALITY CONTROL:** Run available linters/formatters (e.g., flake8, eslint, black, prettier) on modified files to ensure style adherence.
    
    Files modified during this session:
    - ${fileList}
    
    Ensure these files are clean and tests still pass before generating the final patch.
    `;
      // Changed title to reflect the enhanced mandate
      reminderList.push(reminders.formatReminder('CLEANUP PHASE: Quality & State Mandate', body));
    }

    const stagnationWarning = this.stagnationDetector.detectStagnation(currentState);
    if (stagnationWarning) {
      reminderList.push(
        reminders.formatReminder(
          'WARNING: STRATEGIC STAGNATION DETECTED',
          stagnationWarning,
        ),
      );
    }

    // Enhanced Summarization (P2.3)
    if (this.turnCount % cimConfig.summarizationTurnCount === 0) {
      const summary = await this._summarizeConversation();
      // Inject the summary as an explicit Hypothesis/Plan block
      reminderList.push(reminders.formatReminder('Current Strategy (Injected CoT)', summary));
    }

    return { reminders: reminderList };
  }

  // P2.3: Explicit Hypothesis Tracking (Injected Chain-of-Thought)
  private async _summarizeConversation(): Promise<string> {
    const history = await this.geminiClient.getHistory();
    
    // Updated prompt to focus on extraction of hypothesis and plan
    const summarizationPrompt = `
    You are a strategy extraction sub-agent. Analyze the recent conversation history. 
    Extract the agent's CURRENT WORKING HYPOTHESIS and immediate PLAN. Be concise (under 300 characters).

    Focus specifically on the technical root cause the agent suspects and the next actions they intend to take.

    Format the output exactly as:
    HYPOTHESIS: [The specific root cause suspected]
    PLAN: [The immediate next steps]

    History:
    ${JSON.stringify(
      history,
    )}
    `;

    const response = await this.geminiClient.generateContent(
      [{ role: 'user', parts: [{ text: summarizationPrompt }] }],
      // Lower temperature for more deterministic extraction
      { temperature: 0.2 }, 
      new AbortController().signal,
      this.config.getModel(),
    );
    return this._getResponseText(response) ?? 'HYPOTHESIS: N/A\nPLAN: N/A';
  }

  // Proactive Interventions: Path correction, planning mandate, quality control, and context verification nudge
  private async _handlePreToolExecution(payload: any): Promise<CIMOutput> {
    const { requestsToProcess } = payload;
    const projectRoot = this.config.getProjectRoot();
    const currentState = this.tddStateManager.getState();

    for (const request of requestsToProcess) {
      
      // 1. JIT Path Correction (Proactive)
      const pathArgNames = ['file_path', 'path', 'pattern'];
      let requiresAbsolutePath = false;
      let actualPath: string | undefined;

      if (['read_file', 'edit', 'replace', 'write_file', 'list_directory', 'glob'].includes(request.name)) {
        requiresAbsolutePath = true;
        for (const argName of pathArgNames) {
          if (request.args[argName]) {
            actualPath = request.args[argName];
            break;
          }
        }
      }

      if (requiresAbsolutePath && actualPath && projectRoot) {
        // Normalize projectRoot to ensure a trailing slash for robust comparison.
        const normalizedProjectRoot = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;

        // Check if the path is relative (doesn't start with the absolute root) and isn't just '.' or './'.
        if (!actualPath.startsWith(normalizedProjectRoot) && actualPath !== '.' && actualPath !== './' && actualPath !== projectRoot) {
          const suggestedPath = `${normalizedProjectRoot}${actualPath.startsWith('/') ? actualPath.substring(1) : actualPath}`;
          const reminderBody = `
    STOP. INVALID FILE PATH FORMAT DETECTED.

    You attempted to access: ${actualPath}

    All file operations MUST use the ABSOLUTE workspace path. You cannot use relative paths or guess the temporary directory name.
    The current workspace root is: ${projectRoot}

    You MUST prefix the path with the workspace root.
    Example correction: ${suggestedPath}

    Correct the path in your command immediately.
    `;
          return {
            reminders: [reminders.formatReminder('CRITICAL INTERVENTION: Invalid Path Format (Absolute Path Required)', reminderBody)]
          };
        }
      }

      if (request.name === 'run_shell_command') {
        return invokeGuardian(request.args.command, this.geminiClient, this.config);
      }

      if (request.name === 'list_directory' || request.name === 'glob') {
        const path = request.args.path || request.args.pattern;
        // Simplified check for root-level browsing (relative or absolute root)
        if (path === '.' || path === './' || path === '/' || path === projectRoot) {
           const reminderBody = `
You are attempting a broad file listing at the root level. This is inefficient and generates excessive output.
INSTEAD: Use 'grep -r [Keyword]' or 'find . -name "*[Pattern]*"' with specific keywords from the bug report.
Avoid using 'ls' on the root directory.
`;
          return {
            reminders: [reminders.formatReminder('Efficient Exploration Nudge', reminderBody)]
          };
        }
      }

      // P3.2: The Change Size Guardian (Anti-Refactoring)
      if (request.name === 'edit' || request.name === 'replace') {
        const newString = request.args.new_string || '';
        const oldString = request.args.old_string || '';
        // Approximate the change size by looking at the context length in lines
        const newLineCount = newString.split('\n').length;
        const oldLineCount = oldString.split('\n').length;

        if (newLineCount > MAX_CHANGE_SIZE_LINES || oldLineCount > MAX_CHANGE_SIZE_LINES) {
            const contextSize = Math.max(newLineCount, oldLineCount);
            const reminderBody = `
            STOP. The proposed modification context is excessively large (Approx ${contextSize} lines).

            The mandate is to provide the MINIMAL fix required. Do not refactor or modify unrelated code. 
            Ensure your 'old_string' and 'new_string' capture only the necessary context for the fix. Reduce the scope immediately.
            `;
            return {
                reminders: [reminders.formatReminder('INTERVENTION: Excessive Change Size (Scope Creep)', reminderBody)]
            };
        }
      }


      // 2. Premature Implementation Intervention (Mandatory Planning & Context Gathering)
      // Intervenes if the agent tries to modify files while still exploring.
      if (
        (request.name === 'edit' || request.name === 'replace' || request.name === 'write_file') &&
        currentState === TDDState.EXPLORING
      ) {
          const reminderBody = `
          STOP. You are attempting to modify a file while still in the EXPLORING phase.

          MANDATE: Context Gathering and Planning MUST precede Implementation.

          Before proceeding with modifications, you must demonstrate understanding:
          1. **Context:** Have you thoroughly examined the relevant files AND their dependencies (imports/usages)?
          2. **Root Cause:** Have you identified the exact location and underlying cause of the bug?
          3. **Plan Articulation:** Have you articulated a clear, step-by-step plan for the fix based on the gathered context?

          EXCEPTION: If this modification IS the initial reproduction test case (TDD Step 1), you may proceed, but you MUST clearly state that this is your intention now.

          If this is intended as the FIX, you MUST first complete your exploration and articulate your plan. Do not rush implementation.
          `;
           return {
               reminders: [reminders.formatReminder('INTERVENTION: Premature Implementation Attempt (Context/Plan Required)', reminderBody)]
           };
      }


      // 3. Pre-Modification Verification Nudge (Proactive)
      // Focus this specifically on 'edit' and 'replace' which require 'old_string'
      // This acts as the secondary check if the agent is past the EXPLORING phase.
      if (
        request.name === 'edit' ||
        request.name === 'replace'
      ) {

        const reminderBody = `
        You are about to use '${request.name}'. This command requires EXACT context.

        ### CONTEXT VERIFICATION (MANDATORY) ###
        CRITICAL: Have you used 'read_file' (cat) on this file within the last 2 turns?
        If not, STOP. The command WILL FAIL if 'old_string' is not a verbatim match (including whitespace). 
        Verify the file content immediately before modification.

        ### TDD CHECK ###
        Current State: ${reminders.getTDDStateName(currentState)}.
        Have you already achieved REPRO_FAILED (reproduced the bug with a failing test)?
        If not (and you are past EXPLORING), prioritize the test case NOW (unless this modification IS the test case).

        ### QUALITY CONTROL ###
        1. **Minimal Diff:** Is this the smallest change required?
        2. **Style Adherence:** Does your new code PERFECTLY match the surrounding code style?
        `;
        const reminderList = [
          reminders.formatReminder(
            'Pre-Modification Verification & Quality Control',
            reminderBody,
          ),
        ];
        return { reminders: reminderList };
      }
    }
    return { reminders: [] };
  }

  // Reactive Interventions and Enhanced Strategic Guidance
  private async _handlePostToolExecution(payload: any): Promise<CIMOutput> {
    const reminderList: string[] = [];
    const { completedToolCalls } = payload;
    let encounteredError = false;
    const currentState = this.tddStateManager.getState(); // Get state before potential modifications/tests

    for (const toolCall of completedToolCalls) {
      const commandName = toolCall.request.name;
      const commandArgs = JSON.stringify(toolCall.request.args);
      const fileName = toolCall.request.args.file_path;
      // Extract tool output for content analysis
      const toolOutput = (toolCall.response as any)?.output || ''; 

      if (
        (commandName === 'edit' ||
          commandName === 'replace' ||
          commandName === 'write_file') &&
        toolCall.status === 'success'
      ) {
        // This call updates the state based on the modification (e.g., EXPLORING -> WRITING_TEST)
        this.tddStateManager.handleModification(fileName);
      }

      const isTestCommand =
        commandName === 'run_shell_command' &&
        (commandArgs.includes('pytest') ||
          commandArgs.includes('test') ||
          commandArgs.includes('npm run') ||
          commandArgs.includes('manage.py'));

      // --- SUCCESSFUL EXECUTION ANALYSIS ---
      if (toolCall.status === 'success') {
        
        // P1.1. The "Zero Tests Run" Intervention
        if (isTestCommand) {
            // Patterns indicating no tests ran despite success exit code
            const zeroTestPatterns = [
                /0 tests run/i, /No tests found/i, /collected 0 items/i, /^Success: no tests found/i,
                /Ran 0 tests/i,
            ];

            const zeroTestsDetected = zeroTestPatterns.some(pattern => pattern.test(toolOutput));

            if (zeroTestsDetected) {
                const reminderBody = `
                STOP. The test command exited successfully, but the output indicates that NO TESTS WERE ACTUALLY RUN or the suite failed to initialize.

                Output Snippet: ${toolOutput.substring(0, 200)}...

                This does NOT verify the fix.

                ACTION REQUIRED: Identify the correct test runner, arguments, or directory. Do not proceed until tests execute and pass.
                `;
                reminderList.push(reminders.formatReminder('INTERVENTION: Invalid Test Run (0 Tests Executed)', reminderBody));
                
                // CRITICAL: Skip the normal handleTestResult call if 0 tests ran, otherwise TDD state will advance incorrectly.
                continue; 
            }
        }

        // P1.3. The "Silent Failure" (Null Result) Intervention
        if (commandName === 'list_directory' || commandName === 'glob' || (commandName === 'run_shell_command' && (commandArgs.includes('grep') || commandArgs.includes('find')))) {
            // Check if the output is effectively empty (whitespace only)
            if (toolOutput.trim() === '') {
                const reminderBody = `
                The previous command (${commandName}) returned NO RESULTS. 
                Your search criteria did not match anything or the directory is empty. 
                You must acknowledge this and adapt your hypothesis. Do not proceed based on the previous assumption.
                `;
                reminderList.push(reminders.formatReminder('NUDGE: Empty Search Result', reminderBody));
            }
        }
      }

      // Handle TDD state transitions (must happen after Zero Test check)
      if (isTestCommand) {
        // This call updates the state based on test results (e.g., WRITING_TEST -> REPRO_FAILED)
        reminderList.push(...this.tddStateManager.handleTestResult(toolCall.status));
      }

      // --- ERROR EXECUTION ANALYSIS ---
      if (toolCall.status === 'error') {
        encounteredError = true;
        const errorMessage = toolOutput; // Use the extracted toolOutput

        // P2.2. Architectural Error Intervention (AEI)
        const architecturalErrorPatterns = [
            /ImportError/i, /CircularDependencyError/i, /partially initialized module/i,
            /ModuleNotFoundError/i, /SyntaxError: invalid syntax/i // Syntax errors often indicate incorrect assumptions about the code structure
        ];

        const isArchitecturalError = architecturalErrorPatterns.some(pattern => pattern.test(errorMessage));

        if (isArchitecturalError) {
            const reminderBody = `
            The error indicates a structural issue (e.g., circular dependency, import order, syntax error, or missing module). 
            This often means your understanding of the codebase structure or the required syntax is flawed.

            STRATEGY SHIFT REQUIRED:
            1. **Analyze Structure:** If it's an import error, analyze \`__init__.py\` or entry points. Use \`grep "import"\` to map the dependency graph.
            2. **Verify Syntax:** If it's a syntax error, meticulously compare your changes with the surrounding code style and language specification. Use 'cat' to re-read the file immediately.
            3. **Re-evaluate Location:** Are you modifying the correct module?
            `;
            // We prioritize this message but still allow standard error handling below.
            reminderList.push(reminders.formatReminder('STRATEGIC GUIDANCE: Architectural or Syntax Error Detected', reminderBody));
        }


        // 1. Stale Context Intervention (Reactive)
        if (
          (commandName === 'edit' || commandName === 'replace') &&
          (errorMessage.includes('could not find the string to replace') ||
           errorMessage.includes('0 occurrences found for old_string'))
        ) {
          const reminderBody = `
          STOP. EDIT/REPLACE FAILED: The 'old_string' was not found in the file (${fileName || 'Unknown'}).

          Your context is INCORRECT or OUTDATED. The proactive verification check was ignored or failed.

          MANDATORY NEXT ACTION:
          Use \`read_file\` or \`cat\` on the file NOW to see the actual, current content.
          Do not attempt another modification until you have refreshed your context and ensured 'old_string' matches EXACTLY (including whitespace).
          `;
          reminderList.push(reminders.formatReminder('INTERVENTION: Edit Failure (Context Mismatch)', reminderBody));
          this.lastErrorHash = 'STALE_CONTEXT_ERROR'; // Use specific hash
          continue;
        }

        // 2. Path Error Intervention (Reactive fallback)
        // Dynamically extract the path from the error message for robustness.
        const pathErrorMatch = errorMessage.match(/File path must be within one of the workspace directories: ([\s\S]+?)(?: or within|$)/);
        if (pathErrorMatch && pathErrorMatch[1]) {
            const requiredPath = pathErrorMatch[1].trim();
            const reminderBody = `
            STOP. PATH ERROR DETECTED (Fallback).
            The tool failed because you used an incorrect file path, despite previous warnings.
            You MUST use the workspace root: \`${requiredPath}\`

            Example: If you tried 'src/main.py', you MUST use '${requiredPath}/src/main.py'.

            Fix the path now. Do not guess the path.
            `;
            reminderList.push(reminders.formatReminder('INTERVENTION: Invalid File Path (Fallback)', reminderBody));
            this.lastErrorHash = 'PATH_ERROR_FALLBACK';
            continue;
        }


        const errorHash = this._hashError(errorMessage);

        if (this.lastErrorHash === errorHash) {
          const reminderBody = `STOP. The exact same error occurred again.
          Repeating the action will not work. You MUST rethink your strategy.
          Suggestions: Re-examine the code with 'cat', use 'grep' to search for the error source, or explore a different module. Do not repeat the previous command.`;
          reminderList.push(reminders.formatReminder('Repeated Failure Detected - Intervention', reminderBody));
          continue;
        }

        if (isTestCommand) {
            const reminderBody = `
            The testing command failed.
            Traceback/Error: ${errorMessage.substring(0, 500)}...

            ACTION REQUIRED:
            1. Analyze the traceback meticulously. Identify the exact file and line of failure.
            2. Determine if the failure confirms the bug reproduction OR if your fix caused a regression.
            3. Do NOT proceed until you understand the failure.
            `;
            reminderList.push(reminders.formatReminder('Test Failure Analysis', reminderBody));
        } else {
            const reminderBody = `The previous command (${commandName}) failed. DO NOT assume the command succeeded. Analyze the error message and adjust your plan. Do not repeat the same command without modification.`;
            reminderList.push(reminders.formatReminder('Error Detected', reminderBody));
        }

        this.lastErrorHash = errorHash;
        continue;
      }

      // P2.1. The "Step Back" Intervention (Anti-Tunnel Vision)
      // Note: This requires TDDStateManager to track consecutive failures. Assuming it exposes getConsecutiveTestFailures().
      // If TDDStateManager doesn't support this, this block won't function as intended.
      
      // TypeScript check to see if the method exists (as it's defined in a separate file/spec)
      const consecutiveFailures = (this.tddStateManager as any).getConsecutiveTestFailures ? (this.tddStateManager as any).getConsecutiveTestFailures() : 0;

      if (currentState === TDDState.WRITING_FIX && consecutiveFailures >= ANTI_TUNNEL_VISION_THRESHOLD) {
        const reminderBody = `
        STOP. You have failed the tests ${consecutiveFailures} times consecutively while attempting the fix. Your current hypothesis is likely flawed.

        You MUST STEP BACK. Do not attempt another minor patch in the same location.
        Re-evaluate the Root Cause Analysis. Is the bug actually upstream or in a dependency? Formulate a new hypothesis now.
        `;
        // We want this shown every turn until the state changes or success occurs.
        reminderList.push(reminders.formatReminder('INTERVENTION: Hypothesis Failure (Anti-Tunnel Vision)', reminderBody));
      }


      // 3. Enhanced Strategic Guidance (Post read_file)
      if (commandName === 'read_file' && toolCall.status === 'success') {
        const reminderBody = `
        Analyze the file content above. DO NOT RUSH TO EDIT.

        ### ARCHITECTURE & DEPENDENCY ANALYSIS ###
        1. **Imports:** Analyze the IMPORT STATEMENTS. What does this file depend on? Where is it imported from?
        2. **Circular Dependencies:** Does your planned modification risk creating a circular dependency? If you suspect architectural issues, investigate module organization files (e.g., '__init__.py') NOW. (Refer to the Deep Exploration Techniques reminder).
        3. **Interactions:** How does this code interact with other parts of the system?

        ### RISK ASSESSMENT ###
        4. **Hypothesis Check:** Does this code fully explain the bug report, or is it just a symptom?
        5. **Side Effects/Edge Cases:** What are the potential side effects and edge cases (e.g., null values, type mismatches)?

        Ensure you understand the architectural context before modifying.
        `;
        reminderList.push(
          reminders.formatReminder('Code Context & Architecture Analysis', reminderBody),
        );
      }

      if (
        (commandName === 'list_directory' || commandName === 'glob') &&
        toolCall.status === 'success'
      ) {
        // Only add this reminder if the output wasn't empty (handled by P1.3)
        if (toolOutput.trim() !== '') {
            const reminderBody = `Analyze the file list above. Identify potential test files (look for 'tests/' or '_test' patterns) and core logic files. Use this to guide your next exploration step ('cat' or 'grep').`;
            reminderList.push(
            reminders.formatReminder('Post-Execution Analysis', reminderBody),
            );
        }
      }

      if (
        (commandName === 'edit' ||
          commandName === 'replace' ||
          commandName === 'write_file') &&
        toolCall.status === 'success'
      ) {
        const reminderBody = `File modified. You MUST now verify the change.
        Execute the tests using the appropriate runner (e.g., 'pytest', './manage.py test', 'npm test').
        Do not assume the modification works without verification.`;
        reminderList.push(
          reminders.formatReminder('Post-Modification Verification Mandate', reminderBody),
        );
      }

      const target =
        toolCall.request.args.file_path ||
        toolCall.request.args.path ||
        toolCall.request.args.pattern ||
        toolCall.request.args.command?.split(' ')[0] ||
        'N/A';
      this.stagnationDetector.logAction(commandName, target);
    }

    if (!encounteredError) {
      this.lastErrorHash = null;
    }

    return { reminders: reminderList };
  }

  // Loop Detection and Finalization Checks
  private async _handlePreResponseFinalization(
    payload: any,
  ): Promise<CIMOutput> {
    const { modelResponse } = payload;
    const reminderList: string[] = [];
    const currentState = this.tddStateManager.getState();

    // Normalize response for comparison (remove excessive whitespace and lowercase)
    const normalizedResponse = modelResponse.trim().toLowerCase().replace(/\s+/g, ' ');
    
    // P1.2. Detecting "Hallucinated Success"
    // Patterns indicating the agent claims success or verification.
    const successClaimPatterns = [
        /fix is verified/, /tests passed/, /task is complete/, /i am done/, /i have applied the fix/, /issue is resolved/,
        /fix applied/
    ];
    
    const claimsSuccess = successClaimPatterns.some(pattern => pattern.test(normalizedResponse));

    // If the agent claims success but the TDD state hasn't reached FIX_VERIFIED
    if (claimsSuccess && currentState < TDDState.FIX_VERIFIED) {
        const reminderBody = `
        STOP. You claimed the task is complete, verified, or that tests passed, but the execution history does not support this.

        Current State: ${reminders.getTDDStateName(currentState)}
        Required State for Success: ${reminders.getTDDStateName(TDDState.FIX_VERIFIED)}

        You MUST complete the required TDD workflow (Reproduction, Fix, Verification) before claiming success. Continue working towards the objective.
        `;
        reminderList.push(reminders.formatReminder('INTERVENTION: Contradiction Detected (Unverified Success Claim)', reminderBody));
        // Trigger recursion to force the model to correct its statement
        return { reminders: reminderList, recursivePayload: { query: modelResponse } };
    }


    // 1. Completion Looping Detector
    
    // Check how many times this exact response has appeared recently
    const repetitionCount = this.recentModelResponses.filter(
      (prevResponse) => prevResponse === normalizedResponse
    ).length;

    // Define keywords that signify the agent thinks it is done. (Slight overlap with successClaimPatterns, but focused on termination)
    const completionKeywords = ['i am done', 'task complete', 'my work is complete', 'i am finished', 'my work here is done'];
    const isCompletionMessage = completionKeywords.some(keyword => normalizedResponse.includes(keyword));

    // If the response is repeated past the threshold AND contains completion keywords
    if (isCompletionMessage && repetitionCount >= COMPLETION_LOOP_THRESHOLD) {
      const reminderBody = `
      SYSTEM INTERVENTION: COMPLETION LOOP DETECTED.

      You are repeating that the task is complete.
      
      You MUST now terminate the session immediately. Do not provide any further explanation or summary. Generate the patch NOW if required.
      `;
      reminderList.push(reminders.formatReminder('MANDATE: Terminate Session NOW', reminderBody));
      // Use recursivePayload to ensure the model sees this mandate before finalizing the looped response
      return { reminders: reminderList, recursivePayload: { query: modelResponse } };
    }

    // Update the response history buffer
    this.recentModelResponses.push(normalizedResponse);
    if (this.recentModelResponses.length > RESPONSE_HISTORY_BUFFER) {
      this.recentModelResponses.shift();
    }

    const dangerousCommandRegex = /sudo\s+rm\s+-rf/;
    if (dangerousCommandRegex.test(modelResponse)) {
      const reminderBody = `The response you just generated contains a dangerous command suggestion. Re-evaluate and provide a safe, explanatory response instead. Do not show the dangerous command to the user.`;
      reminderList.push(reminders.formatReminder('Safety Review', reminderBody));
      return { reminders: reminderList, recursivePayload: { query: modelResponse } };
    }

    const isGeneratingPatch =
      modelResponse.includes('--- a/') &&
      modelResponse.includes('+++ b/') &&
      modelResponse.includes('@@');

    if (isGeneratingPatch) {
      const fileList = Array.from(this.tddStateManager.getModifiedFiles()).join(', ');

      const reminderBody = `
      You are attempting to generate the final patch. STOP AND REVIEW.

      Before finalizing this patch, confirm the following:
      1. Did you successfully reproduce the original bug with a FAILING test? (State: REPRO_FAILED achieved)
      2. Did you run the tests AFTER your fix and confirm they ALL PASSED? (State: FIX_VERIFIED achieved)
      3. CRITICAL CLEANUP: Did you revert ALL temporary test cases or debugging code from the modified files: [${fileList}]?
      4. Does the patch ONLY include the minimal necessary changes for the fix?

      If the answer to any of these is NO, you MUST go back and correct the situation before generating the patch.
      `;
      reminderList.push(
        reminders.formatReminder(
          'Final Patch Checklist (Self-Correction)',
          reminderBody,
        ),
      );
      return { reminders: reminderList, recursivePayload: { query: modelResponse } };
    }


    return { reminders: [] };
  }
}