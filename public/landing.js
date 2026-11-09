(() => {
  const status = document.querySelector('#availability');
  const retry = document.querySelector('#availability-retry');
  const origin = document.querySelector('meta[name="application-origin"]').content;
  async function check() {
    retry.disabled = true;
    status.textContent = 'Checking application availability…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${origin}/api/availability`, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (typeof data.ready !== 'boolean') throw new Error('Invalid availability');
      status.textContent = data.ready && response.ok
        ? 'Applications are available. Sign in or apply above.'
        : 'Applications are temporarily unavailable. Please try again later; the chronicle remains available.';
    } catch {
      status.textContent = 'Application availability is unknown. The laptop may be offline or the connection interrupted. Try again later.';
    } finally {
      clearTimeout(timer);
      retry.disabled = false;
    }
  }
  retry.addEventListener('click', check);
  check();
})();
