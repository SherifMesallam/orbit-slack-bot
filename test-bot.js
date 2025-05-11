// test-bot.js - A tool to test the Slack bot locally by sending simulated messages
// This simulates Slack API requests without needing an actual Slack connection

import fetch from 'node-fetch';
import readline from 'readline';

// Configuration
const LOCAL_SERVER_URL = 'http://localhost:3000/slack/events';
const TEST_USER_ID = 'U12345678';
const TEST_BOT_ID = 'B08NR1B8LJU'; // Use your actual bot ID
const TEST_CHANNEL_ID = 'C12345678';

// Create readline interface for interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Generate a unique timestamp for each message
const generateTs = () => `${Date.now() / 1000}`;

// Function to send a simulated message event to the server
async function sendMessage(text, options = {}) {
  const ts = options.ts || generateTs();
  const threadTs = options.threadTs || null;
  
  // Create a Slack-like message event
  const payload = {
    token: 'test_token',
    team_id: 'T12345678',
    api_app_id: 'A12345678',
    event: {
      type: 'message',
      user: TEST_USER_ID,
      text: text,
      channel: TEST_CHANNEL_ID,
      channel_type: 'channel',
      ts: ts,
      event_ts: ts,
      team: 'T12345678'
    },
    type: 'event_callback',
    event_id: `Ev${Date.now()}`,
    event_time: Math.floor(Date.now() / 1000)
  };
  
  // Add thread_ts if this is a threaded message
  if (threadTs) {
    payload.event.thread_ts = threadTs;
  }
  
  // If this is a message that mentions the bot
  if (options.mentionBot) {
    payload.event.text = `<@${TEST_BOT_ID}> ${text}`;
  }
  
  console.log(`Sending message: "${text}"${options.mentionBot ? ' (with bot mention)' : ''}${threadTs ? ' (in thread)' : ''}`);
  
  try {
    const response = await fetch(LOCAL_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (response.ok) {
      console.log('Message sent successfully');
      return ts; // Return the timestamp for potential threading
    } else {
      console.error(`Error: ${response.status} - ${response.statusText}`);
      const errorText = await response.text();
      console.error(errorText);
    }
  } catch (error) {
    console.error('Failed to send message:', error);
  }
  
  return ts;
}

// Test scenarios
const testScenarios = {
  'greeting': 'Hello there!',
  'release_info': 'What\'s the latest release of gravityforms?',
  'pr_review': 'Review PR gravityforms/gravityforms#524',
  'issue_analysis': 'Analyze issue gravityforms/gravityforms#456',
  'issue_summary': 'Summarize issue gravityforms/gravityforms#456',
  'github_api': 'Find open issues in the gravityforms repo',
  'technical_question': 'How do I fix the validation error in my form?',
  'docs': 'How do I set up conditional logic?'
};

// Function to display the menu and handle user input
function showMenu() {
  console.log('\n--- Slack Bot Test Tool ---');
  console.log('Select a test scenario or enter a custom message:');
  
  // Display numbered test scenarios
  Object.entries(testScenarios).forEach(([key, value], index) => {
    console.log(`${index + 1}. ${key}: "${value}"`);
  });
  
  console.log('\nOther options:');
  console.log('t. Send as threaded reply');
  console.log('m. Toggle bot mention');
  console.log('c. Custom message');
  console.log('q. Quit');
  
  let currentThreadTs = null;
  let mentionBot = true;
  
  function promptUser() {
    const threadStatus = currentThreadTs ? 'ENABLED' : 'DISABLED';
    const mentionStatus = mentionBot ? 'ENABLED' : 'DISABLED';
    
    rl.question(`\nSelect option [Thread: ${threadStatus}, Mention: ${mentionStatus}]: `, async (answer) => {
      if (answer.toLowerCase() === 'q') {
        console.log('Exiting test tool...');
        rl.close();
        return;
      }
      
      if (answer.toLowerCase() === 't') {
        if (currentThreadTs) {
          currentThreadTs = null;
          console.log('Thread mode disabled');
        } else {
          currentThreadTs = generateTs();
          console.log('Thread mode enabled - next message will start a new thread');
        }
        promptUser();
        return;
      }
      
      if (answer.toLowerCase() === 'm') {
        mentionBot = !mentionBot;
        console.log(`Bot mention ${mentionBot ? 'enabled' : 'disabled'}`);
        promptUser();
        return;
      }
      
      if (answer.toLowerCase() === 'c') {
        rl.question('Enter custom message: ', async (customMessage) => {
          const messageTs = await sendMessage(customMessage, { 
            threadTs: currentThreadTs,
            mentionBot
          });
          
          // If thread mode was just enabled, store the timestamp for future replies
          if (currentThreadTs && !currentThreadTs.includes('.')) {
            currentThreadTs = messageTs;
            console.log(`Thread started with ts: ${currentThreadTs}`);
          }
          
          promptUser();
        });
        return;
      }
      
      const scenarioIndex = parseInt(answer) - 1;
      if (scenarioIndex >= 0 && scenarioIndex < Object.keys(testScenarios).length) {
        const scenarioKey = Object.keys(testScenarios)[scenarioIndex];
        const scenarioText = testScenarios[scenarioKey];
        
        const messageTs = await sendMessage(scenarioText, { 
          threadTs: currentThreadTs,
          mentionBot
        });
        
        // If thread mode was just enabled, store the timestamp for future replies
        if (currentThreadTs && !currentThreadTs.includes('.')) {
          currentThreadTs = messageTs;
          console.log(`Thread started with ts: ${currentThreadTs}`);
        }
      } else {
        console.log('Invalid option, please try again.');
      }
      
      promptUser();
    });
  }
  
  promptUser();
}

// Start the application
console.log('Starting Slack Bot Test Tool...');
showMenu(); 