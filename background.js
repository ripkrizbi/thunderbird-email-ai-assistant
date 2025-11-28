import {DEFAULTS, HARDCODED_TAGS, TAG_KEY_PREFIX, TAG_NAME_PREFIX} from './core/config.js';
import { findEmailParts } from './core/analysis.js';
import { PROVIDER_ENGINES } from './providers';
import {ensureTagsExist} from "./core/tags";

console.log("Spam-Filter Extension: Background script loaded.");

async function analyzeEmail(structuredData) {
  const settings = await messenger.storage.local.get(DEFAULTS);
  const engine = PROVIDER_ENGINES[settings.provider];

  if (engine) {
    // Pass both general settings and custom tags to the engine
    console.log(`Using ${settings.provider}`);
    return await engine(settings, structuredData, settings.customTags);
  } else {
    console.error(`No analysis engine found for provider: ${settings.provider}`);
    return null;
  }
}

async function processMessage(message) {
  try {
    // Check if message has already been processed by checking for our tagged marker
    const messageDetails = await messenger.messages.get(message.id);
    const hasBeenProcessed = messageDetails.tags && messageDetails.tags.some(tag => 
      tag === (TAG_KEY_PREFIX + HARDCODED_TAGS.tagged.key) || 
      tag === HARDCODED_TAGS.tagged.key
    );
    
    if (hasBeenProcessed) {
      console.log("Message already processed, skipping ID:", message.id);
      return 'skipped';
    }

    const fullMessage = await messenger.messages.getFull(message.id);
    const { body, attachments } = findEmailParts(fullMessage.parts);
    
    const structuredData = {
        headers: fullMessage.headers,
        body: body,
        attachments: attachments
    };

    const analysis = await analyzeEmail(structuredData);
    
    if (!analysis) {
      console.log("Skipping tagging due to analysis failure for ID:", message.id);
      return false;
    }

    const { customTags } = await messenger.storage.local.get({ customTags: DEFAULTS.customTags });
    const tagSet = new Set(messageDetails.tags || []);
    
    // Handle hardcoded tags
    if (analysis.is_scam || analysis.spf_pass === false || analysis.dkim_pass === false) tagSet.add(HARDCODED_TAGS.is_scam.key);
    if (analysis.spf_pass === false) tagSet.add(HARDCODED_TAGS.spf_fail.key);
    if (analysis.dkim_pass === false) tagSet.add(HARDCODED_TAGS.dkim_fail.key);

    // Handle dynamic custom tags
    for (const tag of customTags) {
      if (analysis[tag.key] === true) {
        tagSet.add(TAG_KEY_PREFIX + tag.key);
      }
    }
    tagSet.add(TAG_KEY_PREFIX + HARDCODED_TAGS.tagged.key);
    console.log("Spam-Filter Extension: Analysis complete, tagging...", tagSet);

    await messenger.messages.update(message.id, { tags: Array.from(tagSet) });
    return true;
  } catch (error) {
    console.error("Error processing message ID:", message.id, error);
    return false;
  }
}

console.log("Spam-Filter Extension: Setting up onNewMailReceived handler");

messenger.messages.onNewMailReceived.addListener(async (folder, messages) => {
  console.log("Spam-Filter Extension: New messages, yey!");

  // Check if new mail processing is enabled
  const settings = await messenger.storage.local.get(DEFAULTS);
  if (!settings.enableNewMailProcessing) {
    console.log("Spam-Filter Extension: New mail processing is disabled. Skipping.");
    return;
  }

  for (const message of messages.messages) {
    await processMessage(message);
  }
});

// Retroactive folder processing
async function processFolderRetroactively(folder) {
  console.log("Spam-Filter Extension: Starting retroactive processing for folder:", folder);
  
  try {
    // folder is already the folder object from the context menu or message
    const folderName = folder.name || 'Unknown Folder';
    console.log("Processing folder:", folderName);
    
    // Get all messages in the folder
    const page = await messenger.messages.list(folder);
    const allMessages = [...page.messages];
    
    // If there are more messages, we need to handle pagination
    let currentPage = page;
    while (currentPage.id) {
      currentPage = await messenger.messages.continueList(currentPage.id);
      allMessages.push(...currentPage.messages);
    }
    
    console.log(`Found ${allMessages.length} messages to process`);
    
    let processedCount = 0;
    let successCount = 0;
    let skippedCount = 0;
    
    // Show notification about starting processing
    await messenger.notifications.create('processing-start', {
      type: 'basic',
      title: 'Email AI Assistant',
      message: `Starting to process ${allMessages.length} messages in "${folderName}"...`
    });
    
    for (const message of allMessages) {
      const result = await processMessage(message);
      processedCount++;
      
      if (result === true) {
        successCount++;
      } else if (result === 'skipped') {
        skippedCount++;
      }
      
      // Send progress update every 10 messages
      if (processedCount % 10 === 0 || processedCount === allMessages.length) {
        const progressMsg = `Processing: ${processedCount}/${allMessages.length} messages (${skippedCount} already processed)`;
        console.log(progressMsg);
        await messenger.notifications.create('processing-progress', {
          type: 'basic',
          title: 'Email AI Assistant',
          message: progressMsg
        });
      }
    }
    
    // Show completion notification
    const completionMsg = `Completed! Processed ${successCount}/${allMessages.length} messages (${skippedCount} already processed) in "${folderName}"`;
    console.log(completionMsg);
    await messenger.notifications.create('processing-complete', {
      type: 'basic',
      title: 'Email AI Assistant',
      message: completionMsg
    });
    
  } catch (error) {
    console.error("Error processing folder:", error);
    await messenger.notifications.create('processing-error', {
      type: 'basic',
      title: 'Email AI Assistant - Error',
      message: `Error processing folder: ${error.message}`
    });
  }
}

// Set up context menu for folder processing
messenger.menus.create({
  id: "process-folder-ai",
  title: "Process with AI Assistant",
  contexts: ["folder_pane"],
  onclick: async (info) => {
    console.log("Context menu clicked for folder:", info.selectedFolder);
    await processFolderRetroactively(info.selectedFolder);
  }
});

// Listen for messages from content scripts (e.g., from progress dialog)
messenger.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'startFolderProcessing') {
    processFolderRetroactively(message.folderId);
  }
});

// Initialize
ensureTagsExist();