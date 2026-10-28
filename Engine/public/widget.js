/* ===========================================================================
   The embed. ONE script tag, TWO behaviours.

   Inline — put a container on the page:
       <div data-mybot style="height:640px"></div>
       <script src="https://YOUR-BOT-URL/widget.js" async></script>

   Bubble — leave the container out:
       <script src="https://YOUR-BOT-URL/widget.js" async></script>

   Force the bubble even if a container exists:   data-mode="bubble"
   Pick a project other than the default:         data-project="example-co"

   Paste into your website's "custom code" / "embed HTML" block. Squarespace,
   Wix, WordPress, Kajabi, Shopify — they all have one.
   =========================================================================== */
(function () {
  var me = document.currentScript;
  var origin = new URL(me.src).origin;
  var forceBubble = me.getAttribute('data-mode') === 'bubble';
  var project = me.getAttribute('data-project') || '';
  var host = forceBubble ? null : document.querySelector('[data-mybot]:not([data-mybot-done])');
  if (host) host.setAttribute('data-mybot-done', '');

  function frame() {
    var f = document.createElement('iframe');
    f.src = origin + '/?embed=1' + (project ? '&project=' + encodeURIComponent(project) : '');
    f.title = 'Chat';
    f.style.cssText = 'width:100%;height:100%;border:0;border-radius:12px;';
    return f;
  }

  if (host) {
    if (!host.style.height) host.style.height = '640px';
    host.appendChild(frame());
    return;
  }

  var open = false;
  var panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:88px;right:20px;width:400px;height:min(600px,72vh);' +
    'background:#fff;border-radius:14px;overflow:hidden;z-index:2147483000;display:none;' +
    'box-shadow:0 20px 50px -12px rgba(0,0,0,.35);';
  panel.appendChild(frame());

  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Open chat');
  btn.textContent = '💬';
  btn.style.cssText =
    'position:fixed;bottom:20px;right:20px;width:58px;height:58px;border-radius:50%;' +
    'border:0;background:#111827;color:#fff;font-size:24px;cursor:pointer;z-index:2147483001;' +
    'box-shadow:0 10px 25px -6px rgba(0,0,0,.4);';

  function setOpen(next) {
    open = next;
    panel.style.display = open ? 'block' : 'none';
    btn.textContent = open ? '✕' : '💬';
    btn.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  }
  btn.addEventListener('click', function () { setOpen(!open); });

  if (window.matchMedia('(max-width: 520px)').matches) {
    panel.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:#fff;z-index:2147483000;display:none;';
  }
  document.body.appendChild(panel);
  document.body.appendChild(btn);
})();
