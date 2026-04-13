/**
 * bKash redirects the browser here after the user confirms (or cancels).
 *
 * bKash sends: ?paymentID=...&status=success|failure|cancel
 *
 * We render a tiny HTML page with a deep link / postMessage back to the app,
 * then the mobile WebView picks it up, closes the browser overlay, and calls
 * /api/payments/bkash/execute with paymentID to finalize.
 */

export async function GET(request) {
  const url = new URL(request.url);
  const paymentID = url.searchParams.get('paymentID') || '';
  const status = url.searchParams.get('status') || 'unknown';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>পেমেন্ট ${status === 'success' ? 'সম্পন্ন' : 'বাতিল'}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#f8f6f0;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:18px;padding:28px;max-width:360px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px;color:${status === 'success' ? '#15803d' : '#c2410c'}}
p{margin:0;color:#64748b;font-size:14px;line-height:1.5}
.icon{font-size:42px;margin-bottom:12px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${status === 'success' ? '✅' : status === 'cancel' ? '⚠️' : '❌'}</div>
  <h1>${status === 'success' ? 'পেমেন্ট সম্পন্ন হয়েছে!' : status === 'cancel' ? 'পেমেন্ট বাতিল হয়েছে' : 'পেমেন্টে সমস্যা'}</h1>
  <p>অ্যাপে ফিরে যাচ্ছি...</p>
</div>
<script>
  // Payload picked up by the app's WebView navigation listener.
  var payload = { source: 'bkash_callback', paymentID: ${JSON.stringify(paymentID)}, status: ${JSON.stringify(status)} };
  try {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  } catch (e) {}
  // Also navigate to a custom scheme so shouldStartLoadWithRequest can intercept.
  try {
    window.location.href = 'poripurok://payment-callback?paymentID=' + encodeURIComponent(${JSON.stringify(paymentID)}) + '&status=' + encodeURIComponent(${JSON.stringify(status)});
  } catch (e) {}
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
