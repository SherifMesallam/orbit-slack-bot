// test-workspace-detection.js
// Test script for workspace detection in issue analysis

import { detectIntentAndWorkspace } from './src/ai/intentDetectionService.js';
import { getWorkspaces } from './src/services/llmService.js';

// Test cases simulating different issue contents
const testCases = [
  {
    name: "Stripe Issue",
    title: "Issue with Stripe payment gateway",
    body: "When processing a credit card payment, the Stripe checkout form doesn't appear properly on mobile devices. The form is cut off and users can't enter their card details. This only happens with the Stripe add-on.",
    expectedWorkspace: "stripe"
  },
  {
    name: "PayPal Issue",
    title: "PayPal IPN not working",
    body: "We're having problems with PayPal's Instant Payment Notification. The payment goes through but our site isn't receiving the IPN callback, so orders stay in 'pending' status. The PayPal add-on is version 2.5.",
    expectedWorkspace: "paypal"
  },
  {
    name: "User Registration Issue",
    title: "Users can't log in after registration",
    body: "After a user registers using the User Registration add-on, they can't log in with their credentials. The registration completes successfully and shows up in the admin, but login attempts fail.",
    expectedWorkspace: "user-registration"
  },
  {
    name: "Generic Form Issue",
    title: "Form validation not working",
    body: "Form validation rules aren't being applied correctly. I've set a field to be required, but the form submits even when the field is empty. This happens on all forms.",
    expectedWorkspace: "github" // Default for generic issues
  },
  {
    name: "Mailchimp Issue",
    title: "Mailchimp integration failing to sync subscribers",
    body: "Submissions to my form with the Mailchimp add-on aren't being added to my Mailchimp list. The form submits successfully but the user never appears in Mailchimp.",
    expectedWorkspace: "mailchimp"
  }
];

async function runTests() {
  console.log("=== WORKSPACE DETECTION TEST ===");
  
  try {
    // Get available workspaces
    const workspaces = await getWorkspaces(true);
    const workspaceNames = workspaces?.map(w => w.slug) || [];
    console.log(`Available workspaces: ${workspaceNames.join(', ')}\n`);
    
    let passedTests = 0;
    
    for (const testCase of testCases) {
      console.log(`\n--- Testing: ${testCase.name} ---`);
      
      // Create query from issue content
      const query = `Issue about: ${testCase.title} - ${testCase.body}`;
      console.log(`Title: ${testCase.title}`);
      console.log(`Body: ${testCase.body.substring(0, 100)}...`);
      
      // Run workspace detection
      const result = await detectIntentAndWorkspace(query, [], workspaceNames);
      
      // Display results
      console.log(`\nSuggested workspace: ${result.suggestedWorkspace} (Confidence: ${(result.confidence * 100).toFixed(1)}%)`);
      
      if (result.rankedWorkspaces && result.rankedWorkspaces.length > 0) {
        console.log("\nTop ranked workspaces:");
        result.rankedWorkspaces.slice(0, 3).forEach((ws, index) => {
          console.log(`${index+1}. ${ws.name} (${(ws.confidence * 100).toFixed(1)}%)`);
        });
      }
      
      // Check if the expected workspace matches the suggested one
      const passed = result.suggestedWorkspace.toLowerCase() === testCase.expectedWorkspace.toLowerCase();
      console.log(`\nExpected workspace: ${testCase.expectedWorkspace}`);
      console.log(`Test result: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
      
      if (passed) passedTests++;
    }
    
    // Print summary
    console.log("\n=== TEST SUMMARY ===");
    console.log(`${passedTests} out of ${testCases.length} tests passed (${(passedTests/testCases.length*100).toFixed(1)}%)`);
  } catch (error) {
    console.error("Error running tests:", error);
  }
}

runTests().catch(console.error); 