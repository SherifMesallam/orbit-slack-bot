// src/test-intent.js
// Test script for intent detection

import { testReleaseIntentDetection } from './ai/intentProviders/geminiIntentProvider.js';

// Sample queries to test
const queries = [
  // GitHub release info queries
  "What's the latest version of gravityforms?",
  "When was the last update for stripe addon?",
  "What is the latest core release?",
  "Tell me about the most recent Gravity Forms update",
  "What's new in the latest release?",
  
  // Other intents for comparison
  "How do I use the Gravity Forms conditional logic?", // Should be docs
  "Can you help me debug this PHP code?", // Should be technical_question
  "What's the best way to implement webhooks?", // Should be best_practices_question
  "Why was the legacy payment system deprecated?", // Should be historical_knowledge
  "What can you help me with?", // Should be bot_abilities
  "Hello!", // Should be greeting
  
  // Edge cases
  "Latest version information", // Should be github_release_info
  "Find all issues labeled bugs", // Should be github_api_query
  "Review PR 123", // Should be github_pr_review
  "Analyze issue #456", // Should be github_issue_analysis
];

async function runTests() {
  console.log("=== INTENT DETECTION TEST ===");
  console.log(`Testing ${queries.length} queries...\n`);
  
  for (const query of queries) {
    console.log(`\n=== TESTING: "${query}" ===`);
    const result = await testReleaseIntentDetection(query);
    
    // Display primary intent and confidence
    console.log(`Primary Intent: ${result.intent} (${(result.confidence * 100).toFixed(1)}%)`);
    
    // Display top 3 ranked intents if available
    if (result.rankedIntents && result.rankedIntents.length > 0) {
      console.log("\nTop ranked intents:");
      result.rankedIntents.slice(0, 3).forEach((intent, index) => {
        console.log(`${index+1}. ${intent.name} (${(intent.confidence * 100).toFixed(1)}%)`);
      });
    }
    
    // Display suggested workspace
    console.log(`\nSuggested workspace: ${result.suggestedWorkspace}`);
    
    console.log("===============================");
  }
}

runTests().catch(console.error); 