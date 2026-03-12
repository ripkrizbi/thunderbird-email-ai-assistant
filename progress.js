(function(){
  function init() {
    const root      = document.getElementById('progress-root');
    const barFill   = document.getElementById('bar-fill');
    const headerPct = document.getElementById('header-pct');
    const statusText = document.getElementById('status-text');
    const cancelBtn = document.getElementById('cancel-btn');
    const closeBtn  = document.getElementById('close-btn');

    // state: 'processing' | 'done' | 'cancelled' | 'error'
    let state = 'processing';

    function setState(newState) {
      state = newState;
      root.className = '';
      if (newState === 'done')      root.classList.add('state-done');
      if (newState === 'error')     root.classList.add('state-error');
      if (newState !== 'processing') {
        cancelBtn.style.display = 'none';
        closeBtn.disabled = false;
      }
    }

    function setProgress(processed, total, tagged) {
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
      barFill.style.width = pct + '%';
      headerPct.textContent = pct + '%';
      statusText.textContent = `Processing ${processed} / ${total}  \u2022  ${tagged} tagged`;
    }

    function setDone(success, total) {
      barFill.style.width = '100%';
      headerPct.textContent = '100%';
      statusText.textContent = `Done \u2014 ${success} tagged out of ${total}`;
      setState('done');
    }

    function setCancelled(processed, total) {
      statusText.textContent = `Cancelled at ${processed} / ${total}`;
      setState('cancelled');
    }

    // Listen for runtime messages from background
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
      browser.runtime.onMessage.addListener((msg) => {
        if (!msg || state === 'done' || state === 'cancelled') return;
        if (msg.type === 'progressUpdate') {
          setProgress(msg.processed, msg.total, msg.tagged);
        } else if (msg.type === 'progressComplete') {
          setDone(msg.success, msg.total);
        } else if (msg.type === 'progressCancelled') {
          setCancelled(msg.processed || 0, msg.total || 0);
        }
      });
    }

    cancelBtn.addEventListener('click', () => {
      if (state !== 'processing') return;
      setState('cancelled');
      statusText.textContent = 'Cancelling\u2026';
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
        browser.runtime.sendMessage({ type: 'cancelFromUI' });
      }
    });

    closeBtn.addEventListener('click', () => window.close());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
