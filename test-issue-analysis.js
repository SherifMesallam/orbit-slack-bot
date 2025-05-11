// test-issue-analysis.js
// Test script for issue analysis command handler with workspace detection

import { handleIssueAnalysisCommand } from './src/handlers/commandHandler.js';
import { githubToken } from './src/config.js';
import * as githubService from './src/services/githubService.js';

// Mock dependencies
const mockSlack = {
  chat: {
    postMessage: async (opts) => {
      console.log(`[Mock Slack] Posting message: ${opts.text.substring(0, 100)}${opts.text.length > 100 ? '...' : ''}`);
      return { ts: `mock-ts-${Date.now()}` };
    },
    update: async (opts) => {
      console.log(`[Mock Slack] Updating message: ${opts.text.substring(0, 100)}${opts.text.length > 100 ? '...' : ''}`);
      return { ts: opts.ts };
    },
    delete: async (opts) => {
      console.log(`[Mock Slack] Deleting message with ts: ${opts.ts}`);
      return { ok: true };
    }
  }
};

// Mock issue data for testing
const mockIssues = {
  "123": {
    owner: "gravityforms",
    repo: "gravityformsstripe", 
    issue: {
      number: 123,
      title: "Stripe checkout doesn't work on mobile",
      body: "When processing a credit card payment, the Stripe checkout form doesn't appear properly on mobile devices. The form is cut off and users can't enter their card details.",
      url: "https://github.com/gravityforms/gravityformsstripe/issues/123",
      state: "open",
      comments: [
        { user: "user1", body: "I'm seeing this on iPhone 12 with Safari" },
        { user: "user2", body: "Confirmed on Android Chrome as well" }
      ]
    }
  },
  "456": {
    owner: "gravityforms",
    repo: "gravityformspaypal",
    issue: {
      number: 456,
      title: "PayPal IPN not working",
      body: "We're having problems with PayPal's Instant Payment Notification. The payment goes through but our site isn't receiving the IPN callback, so orders stay in 'pending' status.",
      url: "https://github.com/gravityforms/gravityformspaypal/issues/456",
      state: "open",
      comments: [
        { user: "user1", body: "I've verified the IPN URL in PayPal settings is correct" }
      ]
    }
  },
  "789": {
    owner: "gravityforms",
    repo: "gravityforms",
    issue: {
      number: 789,
      title: "Form validation not working",
      body: "Form validation rules aren't being applied correctly. I've set a field to be required, but the form submits even when the field is empty.",
      url: "https://github.com/gravityforms/gravityforms/issues/789",
      state: "open",
      comments: [
        { user: "user1", body: "This happens on all forms." }
      ]
    }
  }
};

// Mock the GitHub service
const originalGetGithubIssueDetails = githubService.getGithubIssueDetails;
githubService.getGithubIssueDetails = async (issueNumber, owner, repo) => {
  const mockKey = `${issueNumber}`;
  if (mockIssues[mockKey]) {
    console.log(`[Mock GitHub] Fetching issue details for ${owner}/${repo}#${issueNumber}`);
    return mockIssues[mockKey].issue;
  }
  console.log(`[Mock GitHub] Issue ${issueNumber} not found in mock data`);
  return null;
};

// Test cases
const testCases = [
  {
    description: "Stripe issue with generic workspace should switch to stripe workspace",
    owner: "gravityforms",
    repo: "gravityformsstripe",
    issueNumber: 123,
    initialWorkspace: "github",
    expectedWorkspace: "stripe"
  },
  {
    description: "PayPal issue with generic workspace should switch to paypal workspace",
    owner: "gravityforms",
    repo: "gravityformspaypal",
    issueNumber: 456,
    initialWorkspace: "github",
    expectedWorkspace: "paypal"
  },
  {
    description: "Generic form issue should stay in github workspace",
    owner: "gravityforms",
    repo: "gravityforms",
    issueNumber: 789,
    initialWorkspace: "github",
    expectedWorkspace: "github"
  },
  {
    description: "Explicitly specified workspace should not be changed even if content suggests otherwise",
    owner: "gravityforms",
    repo: "gravityformsstripe",
    issueNumber: 123,
    initialWorkspace: "specific-custom-workspace",
    expectedWorkspace: "specific-custom-workspace"
  }
];

// Main test function
async function runTests() {
  console.log("=== ISSUE ANALYSIS COMMAND HANDLER TEST ===");
  console.log("Testing workspace detection in issue analysis command handler\n");
  
  if (!githubToken) {
    console.error("GitHub token is not configured. Tests will fail.");
  }
  
  // Keep track of console.log calls to check for workspace changes
  const originalConsoleLog = console.log;
  let consoleOutput = [];
  
  console.log = (...args) => {
    consoleOutput.push(args.join(' '));
    originalConsoleLog(...args);
  };
  
  let passedTests = 0;
  
  for (const [index, test] of testCases.entries()) {
    console.log(`\n--- Test Case ${index + 1}: ${test.description} ---`);
    
    consoleOutput = [];
    
    const replyTarget = "mock-thread-ts";
    const channel = "mock-channel";
    const userPrompt = null;
    const thinkingMsg = { ts: `mock-thinking-${Date.now()}` };
    const thinkingMessagePromise = Promise.resolve(thinkingMsg.ts);
    
    try {
      console.log(`Starting with workspace: ${test.initialWorkspace}`);
      
      // Run the handler
      await handleIssueAnalysisCommand(
        test.owner,
        test.repo,
        test.issueNumber,
        userPrompt,
        replyTarget,
        channel,
        mockSlack,
        githubService.octokit,
        thinkingMessagePromise,
        test.initialWorkspace,
        null
      );
      
      // Check console output for workspace switch
      const workspaceSwitched = consoleOutput.some(log => 
        log.includes('Switching workspace from') && 
        log.includes(`to "${test.expectedWorkspace}"`)
      );
      
      const workspaceUsed = consoleOutput.some(log => 
        log.includes(`using "${test.expectedWorkspace}" workspace`)
      );
      
      const passed = workspaceSwitched || workspaceUsed;
      
      console.log(`\nExpected workspace: ${test.expectedWorkspace}`);
      console.log(`Test result: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
      
      if (passed) passedTests++;
    } catch (error) {
      console.error(`Error in test case ${index + 1}:`, error);
      console.log(`Test result: ❌ FAILED (Error)`);
    }
  }
  
  // Restore original console.log
  console.log = originalConsoleLog;
  
  // Restore original GitHub service
  githubService.getGithubIssueDetails = originalGetGithubIssueDetails;
  
  // Print summary
  console.log("\n=== TEST SUMMARY ===");
  console.log(`${passedTests} out of ${testCases.length} tests passed (${(passedTests/testCases.length*100).toFixed(1)}%)`);
}

// Run the tests
runTests().catch(console.error); 