(function(){
  function init() {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const cancelBtn = document.getElementById('cancel-btn');
    const closeBtn = document.getElementById('close-btn');

    // Listen for runtime messages from the background script
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
      browser.runtime.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'progressUpdate') {
          const { processed, total, tagged } = msg;
          const percent = total ? Math.round((processed/total)*100) : 0;
          if (progressBar) {
            progressBar.max = 100;
            progressBar.value = percent;
          }
          if (progressText) progressText.textContent = `${processed} / ${total} (${tagged} tagged)`;
        } else if (msg.type === 'progressComplete') {
          if (progressText) progressText.textContent = `Completed: ${msg.success}/${msg.total} tagged`;
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
          browser.runtime.sendMessage({ type: 'cancelFromUI' });
        }
        // close the UI immediately
        window.close();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        window.close();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
