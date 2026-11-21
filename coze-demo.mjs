const PROJECT_ID = '7641895293088481286';
// After deploying the Worker, set its exact HTTPS endpoint here.
// This URL is public configuration, not a credential.
const TOKEN_ENDPOINT = 'https://coze-demo-auth.coze-worker-secure-0c1b8f3f48c44ec9a6ff7deb073be221.workers.dev/api/coze-token';
const SDK_URL = 'https://lf-cdn.coze.cn/obj/unpkg/latest/coze/web-sdk/dist/js-umd/index.min.js';

const form = document.querySelector('#unlock');
const input = document.querySelector('#code');
const button = document.querySelector('#start');
const status = document.querySelector('#status');
const gate = document.querySelector('#gate');

let accessCode = '';
let pending;
let sdkReady;
let initialized = false;

async function fetchToken() {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessCode },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('访问未获授权，请核对访问码。');
  }
  if (!response.ok) throw new Error('暂时无法连接扣子，请稍后再试。');
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !result.access_token) {
    throw new Error('未收到有效的临时凭证。');
  }
  return result.access_token;
}

function refreshToken() {
  pending ??= fetchToken().finally(() => { pending = undefined; });
  return pending;
}

function loadSdk() {
  sdkReady ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.referrerPolicy = 'no-referrer';
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error('扣子组件未能加载，请稍后再试。'));
    };
    document.head.append(script);
  }).catch((error) => {
    sdkReady = undefined;
    throw error;
  });
  return sdkReady;
}

function showFailure() {
  gate.hidden = false;
  status.textContent = '扣子连接已失效，请刷新页面后重试。';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled || initialized) return;
  if (!TOKEN_ENDPOINT) {
    input.value = '';
    status.textContent = '演示服务尚未配置，暂时无法打开。';
    return;
  }

  button.disabled = true;
  accessCode = input.value;
  input.value = '';
  status.textContent = '正在连接扣子…';

  try {
    let initialToken = await refreshToken();
    await loadSdk();
    if (typeof window.cozeWebSDK?.init !== 'function') {
      throw new Error('扣子组件不可用，请稍后再试。');
    }

    window.cozeWebSDK.init({
      projectId: PROJECT_ID,
      refreshToken: async () => {
        if (initialToken) {
          const token = initialToken;
          initialToken = '';
          return token;
        }
        try {
          return await refreshToken();
        } catch {
          showFailure();
          throw new Error('无法更新扣子访问凭证。');
        }
      },
      onTokenInvalid: showFailure,
    });
    initialized = true;
    form.hidden = true;
    gate.hidden = true;
    status.textContent = '';
  } catch (error) {
    accessCode = '';
    status.textContent = error instanceof TypeError || error.name === 'TimeoutError'
      ? '连接失败，请检查网络后重试。'
      : '无法打开演示。' + (error.message || '请稍后再试。');
    input.focus();
  } finally {
    button.disabled = false;
  }
});
