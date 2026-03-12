import {DEFAULTS, HARDCODED_TAGS, TAG_KEY_PREFIX, TAG_NAME_PREFIX} from './core/config.js';
import { findEmailParts } from './core/analysis.js';
import { PROVIDER_ENGINES } from './providers';
import {ensureTagsExist} from "./core/tags";
import { setDebug, log, info, warn, error } from './core/debug.js';

// Global flag for cancelling retroactive processing
let processingCancelled = false;

// Global flag to track if LLM API is unavailable
let apiUnavailable = false;
// Progress window id
let progressWindowId = null;
// Progress sidebar open flag
let progressSidebarOpen = false;

// Initialization: read debug setting and run startup tasks
(async () => {
  try {
    const settings = await messenger.storage.local.get(DEFAULTS);
    setDebug(settings.debugMode);
    log("Spam-Filter Extension: Background script loaded.");
    // Ensure tags exist on startup
    await ensureTagsExist();
  } catch (e) {
    error("Error during background init:", e);
  }
})();

async function analyzeEmail(structuredData) {
  // If API is marked unavailable, skip processing to avoid retries
  if (apiUnavailable) {
    log("API marked as unavailable, skipping analysis");
    return null;
  }
  
  const settings = await messenger.storage.local.get(DEFAULTS);
  log("Spam-Filter Extension: analyzeEmail called");
  log("Provider:", settings.provider);
  
  const engine = PROVIDER_ENGINES[settings.provider];

  if (engine) {
    // Pass both general settings and custom tags to the engine
    log(`Using ${settings.provider} engine`);
    log("Calling analysis engine...");
    try {
      const result = await engine(settings, structuredData, settings.customTags);
      log("Analysis engine returned:", result);
      return result;
    } catch (err) {
      // 405 = wrong endpoint URL in settings - config error, not a transient failure
      if (err.message.includes('405')) {
        error("LLM API configuration error (405 Method Not Allowed) - check Ollama URL in settings");
        try {
          await messenger.notifications.create('api-config-error', {
            type: 'basic',
            title: 'Email AI Assistant – Configuration Error',
            message: `Ollama returned 405 Method Not Allowed. Check that the Ollama URL in settings ends with /api/generate.`
          });
        } catch (_) {}
        throw err;
      }
      // Network error or timeout → mark API as unavailable temporarily
      if (err.message.includes('API timeout') || err.message.includes('Failed to fetch') || err.name === 'AbortError') {
        error("LLM API unavailable or unreachable - stopping processing");
        apiUnavailable = true;
        // Reset after a short delay to allow recovery
        setTimeout(() => { apiUnavailable = false; }, 60000);
      }
      throw err;
    }
  } else {
    error(`No analysis engine found for provider: ${settings.provider}`);
    return null;
  }
}

async function processMessage(message, forceReprocess = false) {
  try {
    log("Spam-Filter Extension: Processing message ID:", message.id, "Force reprocess:", forceReprocess);
    
    // Check if message has already been processed by checking for our tagged marker
    const messageDetails = await messenger.messages.get(message.id);
    log("Message details:", messageDetails);
    log("Message tags:", messageDetails.tags);
    
    const hasBeenProcessed = messageDetails.tags && messageDetails.tags.some(tag => 
      tag === (TAG_KEY_PREFIX + HARDCODED_TAGS.tagged.key) || 
      tag === HARDCODED_TAGS.tagged.key
    );
    
    if (hasBeenProcessed && !forceReprocess) {
        log("Message already processed, skipping ID:", message.id);
      return 'skipped';
    }

    const fullMessage = await messenger.messages.getFull(message.id);
    log("Full message retrieved, parsing parts...");
    const { body, attachments } = findEmailParts(fullMessage.parts || []);
    log("Email parts found - Body length:", body ? body.length : 0, "Attachments:", attachments.length);
    
    if (!body) {
      log("Message has no body content, skipping ID:", message.id);
      return 'skipped';
    }
    
    const structuredData = {
        headers: fullMessage.headers,
        body: body,
        attachments: attachments
    };

    log("Analyzing email...");
    const analysis = await analyzeEmail(structuredData);
    log("Analysis result:", analysis);
    
    if (!analysis) {
        log("Skipping tagging due to analysis failure for ID:", message.id);
      return false;
    }

    const { customTags } = await messenger.storage.local.get({ customTags: DEFAULTS.customTags });
    const tagSet = new Set(messageDetails.tags || []);
    
    log("Current tags before processing:", Array.from(tagSet));
    
    // Handle hardcoded tags
    if (analysis.is_scam || analysis.spf_pass === false || analysis.dkim_pass === false) tagSet.add(TAG_KEY_PREFIX + HARDCODED_TAGS.is_scam.key);
    if (analysis.spf_pass === false) tagSet.add(TAG_KEY_PREFIX + HARDCODED_TAGS.spf_fail.key);
    if (analysis.dkim_pass === false) tagSet.add(TAG_KEY_PREFIX + HARDCODED_TAGS.dkim_fail.key);

    // Handle dynamic custom tags
    for (const tag of customTags) {
      if (analysis[tag.key] === true) {
        tagSet.add(TAG_KEY_PREFIX + tag.key);
      }
    }
    tagSet.add(TAG_KEY_PREFIX + HARDCODED_TAGS.tagged.key);
    log("Spam-Filter Extension: Analysis complete, new tags to apply:", Array.from(tagSet));

    const tagsArray = Array.from(tagSet);
    log("Updating message with tags:", tagsArray);
    await messenger.messages.update(message.id, { tags: tagsArray });
    log("Message updated successfully");
    return true;
  } catch (err) {
    error("Error processing message ID:", message.id, err);
    error("Error stack:", err.stack);
    return false;
  }
}

log("Spam-Filter Extension: Setting up onNewMailReceived handler");

messenger.messages.onNewMailReceived.addListener(async (folder, messages) => {
  log("Spam-Filter Extension: New messages, yey!");

  // Check if new mail processing is enabled
  const settings = await messenger.storage.local.get(DEFAULTS);
  if (!settings.enableNewMailProcessing) {
    log("Spam-Filter Extension: New mail processing is disabled. Skipping.");
    return;
  }

  for (const message of messages.messages) {
    await processMessage(message);
  }
});

// Process a list of messages (for single/multi-message selection)
async function processMessages(messages) {
  log("Spam-Filter Extension: Starting processing for", messages.length, "message(s)");
  
  if (!messages || messages.length === 0) {
    error("No messages to process");
    return;
  }
  
  try {
    // Get the force reprocess setting
    const settings = await messenger.storage.local.get(DEFAULTS);
    const forceReprocess = settings.forceReprocessInMessageMode;
    log("Force reprocess setting:", forceReprocess);
    
    processingCancelled = false;
    let processedCount = 0;
    let successCount = 0;
    let skippedCount = 0;
    // Try opening a sidebar; fall back to popup if sidebarAction is not available
    progressSidebarOpen = false;
    try {
      if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.setPanel) {
        await browser.sidebarAction.setPanel({ panel: messenger.runtime.getURL('progress.html') });
      }
      if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
        await browser.sidebarAction.open();
        progressSidebarOpen = true;
      }
    } catch (e) {
      log('Sidebar open failed, will try popup fallback', e);
      progressSidebarOpen = false;
    }

    if (!progressSidebarOpen) {
      try {
        const mainWin = await messenger.windows.getCurrent();
        // Create a normally-sized popup positioned near bottom-right of the main window
        const popupWidth = 360;
        const popupHeight = 120;
        const margin = 12;
        const left = (mainWin.left || 0) + Math.max(0, ((mainWin.width || 800) - popupWidth - margin));
        const top = (mainWin.top || 0) + Math.max(0, ((mainWin.height || 600) - popupHeight - margin));
        const win = await messenger.windows.create({ url: messenger.runtime.getURL('progress.html'), type: 'popup', left, top, width: popupWidth, height: popupHeight });
        progressWindowId = win.id;
      } catch (e) {
        log('Could not open progress window, falling back to notifications', e);
        progressWindowId = null;
      }
    }
    
    // Show a cancel notification
    try {
      await messenger.notifications.create('processing-cancel', {
        type: 'basic',
        title: 'Email AI Assistant - Processing',
        message: `Processing ${messages.length} message(s). Click to cancel.`,
        isClickable: true
      });
      log("Processing cancel notification created");
    } catch (notifErr) {
      error("Failed to create notification:", notifErr);
    }
    
    for (const message of messages) {
      // Check if processing was cancelled
      if (processingCancelled) {
        log("Processing cancelled. Stopped at message", processedCount, 'of', messages.length);
        await messenger.notifications.clear('processing-cancel');
        // close any UI
        if (progressSidebarOpen) {
          try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
          progressSidebarOpen = false;
        }
        if (progressWindowId) {
          try { await messenger.windows.remove(progressWindowId); } catch (e) {}
          progressWindowId = null;
        }
        return;
      }
      
      // Check if API became unavailable
      if (apiUnavailable) {
        log("LLM API became unavailable. Stopping processing at message", processedCount, 'of', messages.length);
        await messenger.notifications.clear('processing-cancel');
        // close any UI
        if (progressSidebarOpen) {
          try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
          progressSidebarOpen = false;
        }
        if (progressWindowId) {
          try { await messenger.windows.remove(progressWindowId); } catch (e) {}
          progressWindowId = null;
        }
        await messenger.notifications.create('processing-error', {
          type: 'basic',
          title: 'Email AI Assistant - API Unavailable',
          message: `LLM API is unavailable or unreachable. Stopped after ${processedCount} messages. Will retry in 1 minute.`
        });
        return;
      }
      
      const result = await processMessage(message, forceReprocess);
      processedCount++;
      
      if (result === true) {
        successCount++;
      } else if (result === 'skipped') {
        skippedCount++;
      }
      
      // Send progress update
      if (processedCount % 5 === 0 || processedCount === messages.length) {
        const progressMsg = `Processing: ${processedCount}/${messages.length} messages (${skippedCount} already processed)`;
        log(progressMsg);
        // Send progress to progress window if open
        try {
          messenger.runtime.sendMessage({ type: 'progressUpdate', processed: processedCount, total: messages.length, tagged: successCount });
        } catch (e) {}
      }
    }
    
    // Clear the cancel notification and show completion
    await messenger.notifications.clear('processing-cancel');
    const completionMsg = `Completed! Processed ${successCount}/${messages.length} messages (${skippedCount} already processed)`;
    log(completionMsg);
    try { messenger.runtime.sendMessage({ type: 'progressComplete', success: successCount, total: messages.length }); } catch (e) {}
    if (progressSidebarOpen) {
      try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
      progressSidebarOpen = false;
    }
    if (progressWindowId) {
      try { await messenger.windows.remove(progressWindowId); } catch (e) {}
      progressWindowId = null;
    }
    
  } catch (err) {
    error("Error processing messages:", err);
    await messenger.notifications.create('processing-error', {
      type: 'basic',
      title: 'Email AI Assistant - Error',
      message: `Error processing messages: ${err.message}`
    });
  }
}

// Retroactive folder processing
async function processFolderRetroactively(folder) {
  log("Spam-Filter Extension: Starting retroactive processing for folder:", folder);

  try {
    // folder is already the folder object from the context menu or message
    const folderName = folder.name || 'Unknown Folder';
    log("Processing folder:", folderName);
    log("Folder object:", JSON.stringify(folder, null, 2));
    
    // Get all messages in the folder
    log("Fetching messages from folder...");
    const page = await messenger.messages.list(folder);
    log("First page results:", page.messages.length, "messages, page ID:", page.id);
    const allMessages = [...page.messages];
    
    // If there are more messages, we need to handle pagination
    let currentPage = page;
    let pageCount = 1;
    while (currentPage.id) {
      log("Fetching next page...");
      currentPage = await messenger.messages.continueList(currentPage.id);
      log("Page", pageCount + 1, "results:", currentPage.messages.length, "messages");
      allMessages.push(...currentPage.messages);
      pageCount++;
    }
    
    log(`Total messages found: ${allMessages.length}`);
    
    // Try opening a sidebar; fall back to popup if sidebarAction is not available
    progressSidebarOpen = false;
    try {
      if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.setPanel) {
        await browser.sidebarAction.setPanel({ panel: messenger.runtime.getURL('progress.html') });
      }
      if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
        await browser.sidebarAction.open();
        progressSidebarOpen = true;
      }
    } catch (e) {
      log('Sidebar open failed for folder processing, will try popup fallback', e);
      progressSidebarOpen = false;
    }

    if (!progressSidebarOpen) {
      try {
        const mainWin = await messenger.windows.getCurrent();
        // Create a normally-sized popup positioned near bottom-right of the main window
        const popupWidth = 360;
        const popupHeight = 120;
        const margin = 12;
        const left = (mainWin.left || 0) + Math.max(0, ((mainWin.width || 800) - popupWidth - margin));
        const top = (mainWin.top || 0) + Math.max(0, ((mainWin.height || 600) - popupHeight - margin));
        const win = await messenger.windows.create({ url: messenger.runtime.getURL('progress.html'), type: 'popup', left, top, width: popupWidth, height: popupHeight });
        progressWindowId = win.id;
      } catch (e) {
        log('Could not open progress window for folder processing, falling back to notifications', e);
        progressWindowId = null;
      }
    }

    let processedCount = 0;
    let successCount = 0;
    let skippedCount = 0;
    
    // Show a cancel notification
    try {
      await messenger.notifications.create('processing-cancel', {
        type: 'basic',
        title: 'Email AI Assistant - Processing',
        message: `Processing ${allMessages.length} messages in "${folderName}". Click to cancel.`,
        isClickable: true
      });
      log("Processing cancel notification created");
    } catch (notifErr) {
      error("Failed to create notification:", notifErr);
    }
    
    // (notifications for start/progress/completion removed - use console debug instead)
    
    for (const message of allMessages) {
      // Check if processing was cancelled
      if (processingCancelled) {
        log("Processing cancelled. Stopped at message", processedCount, 'of', allMessages.length);
        await messenger.notifications.clear('processing-cancel');
        // close any UI
        if (progressSidebarOpen) {
          try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
          progressSidebarOpen = false;
        }
        if (progressWindowId) {
          try { await messenger.windows.remove(progressWindowId); } catch (e) {}
          progressWindowId = null;
        }
        return;
      }
      
      // Check if API became unavailable
      if (apiUnavailable) {
        log("LLM API became unavailable. Stopping folder processing at message", processedCount, 'of', allMessages.length);
        await messenger.notifications.clear('processing-cancel');
        // close any UI
        if (progressSidebarOpen) {
          try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
          progressSidebarOpen = false;
        }
        if (progressWindowId) {
          try { await messenger.windows.remove(progressWindowId); } catch (e) {}
          progressWindowId = null;
        }
        await messenger.notifications.create('processing-error', {
          type: 'basic',
          title: 'Email AI Assistant - API Unavailable',
          message: `LLM API is unavailable or unreachable. Stopped after ${processedCount} of ${allMessages.length} messages. Will retry in 1 minute.`
        });
        return;
      }
      
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
        log(progressMsg);
        try { messenger.runtime.sendMessage({ type: 'progressUpdate', processed: processedCount, total: allMessages.length, tagged: successCount }); } catch (e) {}
      }
    }
    
    // Clear the cancel notification and show completion
    await messenger.notifications.clear('processing-cancel');
    const completionMsg = `Completed! Processed ${successCount}/${allMessages.length} messages (${skippedCount} already processed) in "${folderName}"`;
    log(completionMsg);
    try { messenger.runtime.sendMessage({ type: 'progressComplete', success: successCount, total: allMessages.length }); } catch (e) {}
    if (progressWindowId) { try { await messenger.windows.remove(progressWindowId); } catch (e) {} progressWindowId = null; }
    
  } catch (err) {
    error("Error processing folder:", err);
    await messenger.notifications.create('processing-error', {
      type: 'basic',
      title: 'Email AI Assistant - Error',
      message: `Error processing folder: ${err.message}`
    });
  }
}

// Set up context menu for folder processing
messenger.menus.create({
  id: "process-folder-ai",
  title: "Process with AI Assistant",
  contexts: ["folder_pane"],
  onclick: async (info) => {
    log("Context menu clicked for folder:", info.selectedFolder?.name || 'Unknown');
    processingCancelled = false; // Reset cancel flag when starting new processing
    try {
      await processFolderRetroactively(info.selectedFolder);
    } catch (e) {
      error("Error in context menu handler:", e);
    }
  }
});

// Set up context menu for message processing
messenger.menus.create({
  id: "process-message-ai",
  title: "Process with AI Assistant",
  contexts: ["message_list"],
  onclick: async (info) => {
    log("Context menu clicked for message(s)");
    processingCancelled = false; // Reset cancel flag when starting new processing
    try {
      if (info.selectedMessages && info.selectedMessages.messages) {
        await processMessages(info.selectedMessages.messages);
      } else {
        error("No messages selected");
      }
    } catch (e) {
      error("Error in message context menu handler:", e);
    }
  }
});

// Handle cancel button from notification
messenger.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'processing-cancel') {
    processingCancelled = true;
    log("Processing cancelled by user");
  }
});

// Listen for messages from content scripts (e.g., from progress dialog)
messenger.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === 'startFolderProcessing') {
    processingCancelled = false;
    processFolderRetroactively(message.folderId);
  } else if (message.type === 'cancelProcessing' || message.type === 'cancelFromUI') {
    processingCancelled = true;
    log('Processing cancelled from UI');
    // close progress window if open
    if (progressWindowId) {
      try { messenger.windows.remove(progressWindowId); } catch (e) {}
      progressWindowId = null;
    }
    if (progressSidebarOpen) {
      try { if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) await browser.sidebarAction.close(); } catch (e) {}
      progressSidebarOpen = false;
    }
  }
});

// Initialization moved to async startup block above