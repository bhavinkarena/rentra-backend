'use client';

export function measureBrowser(event, visits = 'unknown') {
  if (process.env.NEXT_PUBLIC_RENTRA_MEASUREMENT_ENABLED !== 'true' || navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  // No URL, referrer, user identifier or input value enters the request.
  void fetch('/api/measurement', { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, source: 'browser', device: window.innerWidth < 768 ? 'mobile' : 'desktop', visits }),
  }).catch(() => {});
}
