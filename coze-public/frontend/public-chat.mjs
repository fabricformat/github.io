const ENDPOINT = 'https://coze-public-demo.coze-worker-secure-0c1b8f3f48c44ec9a6ff7deb073be221.workers.dev/api/chat';
const form = document.querySelector('#ask');
const field = document.querySelector('#question');
const send = document.querySelector('#send');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const answer = document.querySelector('#answer');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = field.value.trim();
  if (!message || send.disabled) return;
  if (!ENDPOINT.startsWith('https://')) {
    status.textContent = '演示服务尚未配置。';
    return;
  }
  send.disabled = true;
  answer.textContent = '';
  result.hidden = true;
  status.textContent = '正在回答…';
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message}), credentials: 'omit',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(45000),
    });
    if (response.status === 429) {
      status.textContent = '公开演示已达当前用量上限，请稍后再试。';
      return;
    }
    if (response.status === 400 || response.status === 413) {
      status.textContent = '请检查问题内容和长度后重试。';
      return;
    }
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error();
    answer.textContent = data.answer;
    result.hidden = false;
    status.textContent = '回答已生成。';
  } catch {
    status.textContent = '暂时无法获取回答，请稍后再试。';
  } finally {
    send.disabled = false;
  }
});
