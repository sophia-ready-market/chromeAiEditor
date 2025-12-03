let isProcessing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AI_ASSIST_TRIGGER' && !isProcessing) {
    isProcessing = true;
    DebugLogger.log('CONTENT_SCRIPT', 'AI assist trigger received', message);
    
    processAiAssist(message.headerConfig)
      .then(async () => {
        await DebugLogger.log('CONTENT_SCRIPT', 'AI assist processing completed successfully');
        isProcessing = false;
        sendResponse({ success: true });
      })
      .catch(async (error) => {
        await DebugLogger.error('CONTENT_SCRIPT', 'AI assist processing failed', error);
        isProcessing = false;
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function processAiAssist(headerConfig) {
  await DebugLogger.log('AI_PROCESS', 'Starting AI assist processing');
  
  const config = await getConfiguration(headerConfig);
  if (!config || !config.targets) {
    await DebugLogger.warn('AI_PROCESS', 'No valid AI configuration found');
    return;
  }
  
  await DebugLogger.log('AI_PROCESS', 'Configuration loaded successfully', config);
  
  const context = await collectContext();
  await DebugLogger.log('AI_PROCESS', 'Context collected', context);
  
  const requestData = {
    prompt: config.prompt || 'Fill the form fields based on the context',
    context: context,
    targets: config.targets
  };
  
  await DebugLogger.log('AI_PROCESS', 'Sending AI request to background', requestData);
  
  const aiResponse = await chrome.runtime.sendMessage({
    type: 'AI_REQUEST',
    data: requestData
  });
  
  if (aiResponse.success) {
    await DebugLogger.log('AI_PROCESS', 'AI request successful, filling fields', aiResponse.data);
    fillFields(config.targets, aiResponse.data);
  } else {
    await DebugLogger.error('AI_PROCESS', 'AI request failed', aiResponse.error);
  }
}

async function getConfiguration(headerConfig) {
  await DebugLogger.log('CONFIG', 'Getting configuration', { headerConfig });
  
  let config = headerConfig || {};
  
  const scriptConfig = document.getElementById('ai-config');
  if (scriptConfig) {
    try {
      const pageConfig = JSON.parse(scriptConfig.textContent);
      await DebugLogger.log('CONFIG', 'Page config found and parsed', pageConfig);
      config = { ...config, ...pageConfig };
    } catch (e) {
      await DebugLogger.warn('CONFIG', 'Failed to parse page AI config', e);
    }
  } else {
    await DebugLogger.log('CONFIG', 'No page config script found');
  }
  
  if (!config.targets) {
    await DebugLogger.log('CONFIG', 'No targets specified, inferring from page elements');
    config.targets = inferTargets();
  }
  
  await DebugLogger.log('CONFIG', 'Final configuration assembled', config);
  
  return config;
}

async function collectContext() {
  const contextElements = document.querySelectorAll('[data-ai-context]');
  const context = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    contextBlocks: []
  };
  
  DebugLogger.log('CONTEXT', `Found ${contextElements.length} context elements`);
  
  contextElements.forEach((element, index) => {
    const label = element.getAttribute('data-ai-context') || `context-${index}`;
    const content = element.textContent.trim();
    
    context.contextBlocks.push({
      label: label,
      content: content
    });
    
    DebugLogger.log('CONTEXT', `Context block "${label}": ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
  });

  const previewIframe = document.querySelector('#preview-container iframe');
  if (previewIframe?.src) {
    try {
      const previewUrl = new URL(previewIframe.src, window.location.href).href;
      DebugLogger.log('CONTEXT', 'Preview iframe detected', { previewUrl });

      if (previewUrl.includes('.pre')) {
        const response = await fetch(previewUrl, { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`Preview fetch failed with status ${response.status}`);
        }

        const previewText = await response.text();
        const truncatedPreview = previewText.slice(0, 8000);
        context.contextBlocks.push({
          label: 'preview-container',
          content: truncatedPreview
        });

        context.previewUrl = previewUrl;
        context.previewContentLength = previewText.length;

        DebugLogger.log('CONTEXT', 'Preview content captured', {
          previewUrl,
          capturedLength: truncatedPreview.length
        });
      }
    } catch (error) {
      DebugLogger.warn('CONTEXT', 'Failed to capture preview content', error);
    }
  }
  
  return context;
}

function inferTargets() {
  const targets = [];
  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], input[type="number"], input[type="tel"], input[type="url"], textarea, select, input[type="checkbox"], input[type="radio"]');
  
  DebugLogger.log('TARGET_INFERENCE', `Found ${inputs.length} potential target elements`);
  
  inputs.forEach((input, index) => {
    const name = input.name || input.id || `field-${index}`;
    const selector = input.id ? `#${input.id}` : 
                    input.name ? `[name="${input.name}"]` : 
                    `${input.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
    
    let type = 'text';
    if (input.type === 'checkbox' || input.type === 'radio') {
      type = input.type;
    } else if (input.tagName === 'SELECT') {
      type = 'select';
    }
    
    const target = {
      name: name,
      selector: selector,
      type: type
    };
    
    targets.push(target);
    
    DebugLogger.log('TARGET_INFERENCE', `Inferred target: ${name} -> ${selector} (type: ${type})`);
  });
  
  return targets;
}

function fillFields(targets, aiData) {
  const normalizedData = { ...(aiData || {}) };

  if (targets?.some(target => target.name === 'preview-toggle')) {
    normalizedData['preview-toggle'] = true;
    DebugLogger.log('FIELD_FILLING', 'preview-toggle enforced to true');
  }

  if (targets?.some(target => target.name === 'device-toggle')) {
    normalizedData['device-toggle'] = false;
    DebugLogger.log('FIELD_FILLING', 'device-toggle enforced to false');
  }

  DebugLogger.log('FIELD_FILLING', 'Starting to fill fields', { targets, aiData: normalizedData });
  
  targets.forEach(target => {
    const element = document.querySelector(target.selector);
    if (!element) {
      DebugLogger.warn('FIELD_FILLING', `Target element not found: ${target.selector}`);
      return;
    }
    
    const value = normalizedData[target.name];
    if (value === undefined) {
      DebugLogger.warn('FIELD_FILLING', `No AI data for target: ${target.name}`);
      return;
    }
    
    DebugLogger.log('FIELD_FILLING', `Filling field "${target.name}" (type: ${target.type}) with value:`, value);
    
    fillSingleField(element, target, value);
    
    showAiIndicator(element);
    
    DebugLogger.log('FIELD_FILLING', `Successfully filled field "${target.name}"`);
  });
  
  DebugLogger.log('FIELD_FILLING', 'Field filling completed');
}

function fillSingleField(element, target, value) {
  switch (target.type) {
    case 'checkbox':
      const isChecked = parseBooleanValue(value);
      element.checked = isChecked;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
      
    case 'radio':
      // For radio buttons, we need to handle both boolean and specific values
      if (element.value === String(value) || parseBooleanValue(value)) {
        element.checked = true;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
      
    case 'select':
      const stringValue = String(value);
      // Try to find matching option by value or text
      let optionFound = false;
      
      for (let option of element.options) {
        if (option.value === stringValue || option.text === stringValue) {
          element.value = option.value;
          optionFound = true;
          break;
        }
      }
      
      // If no exact match, try partial match
      if (!optionFound) {
        for (let option of element.options) {
          if (option.text.toLowerCase().includes(stringValue.toLowerCase()) ||
              option.value.toLowerCase().includes(stringValue.toLowerCase())) {
            element.value = option.value;
            optionFound = true;
            break;
          }
        }
      }
      
      if (!optionFound) {
        DebugLogger.warn('FIELD_FILLING', `No matching option found for select "${target.name}" with value: ${stringValue}`);
      }
      
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
      
    case 'json':
      element.value = JSON.stringify(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
      
    default:
      // Text inputs, textarea, etc.
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
  }
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  
  const stringValue = String(value).toLowerCase().trim();
  return stringValue === 'true' || 
         stringValue === '1' || 
         stringValue === 'yes' || 
         stringValue === 'on' ||
         stringValue === 'checked';
}

function showAiIndicator(element) {
  const existingIndicator = element.parentNode.querySelector('.ai-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
  
  const indicator = document.createElement('span');
  indicator.className = 'ai-indicator';
  indicator.textContent = 'AI ✓';
  indicator.style.cssText = `
    position: absolute;
    background: #4CAF50;
    color: white;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
    z-index: 10000;
    pointer-events: none;
    font-family: Arial, sans-serif;
  `;
  
  const rect = element.getBoundingClientRect();
  indicator.style.left = (rect.right + window.scrollX - 30) + 'px';
  indicator.style.top = (rect.top + window.scrollY - 5) + 'px';
  
  document.body.appendChild(indicator);
  
  setTimeout(() => {
    indicator.remove();
  }, 3000);
}