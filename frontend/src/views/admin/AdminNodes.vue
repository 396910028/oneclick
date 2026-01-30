<template>
  <n-space vertical :size="16">
    <n-card title="内部接口密钥（INTERNAL_API_KEY）">
      <n-space vertical :size="12">
        <n-alert type="info" :show-icon="false">
          <div style="font-size: 12px;">
            该密钥用于节点对接程序（connector / 一键脚本）访问面板的内部接口（<code>/api/internal/*</code>）。修改后将立即影响新对接请求。
          </div>
        </n-alert>
        <n-space align="center" :size="12">
          <n-text strong style="min-width: 140px;">INTERNAL_API_KEY</n-text>
          <n-input
            v-model:value="internalApiKey"
            type="password"
            show-password-on="click"
            placeholder="当前 backend 进程使用的 INTERNAL_API_KEY"
            style="max-width: 520px; flex: 1;"
          />
          <n-button size="small" secondary :loading="internalKeyLoading" @click="refreshInternalKey">
            刷新
          </n-button>
          <n-button size="small" type="primary" :loading="internalKeyLoading" @click="saveInternalKey">
            保存
          </n-button>
        </n-space>
        <n-text depth="3" style="font-size: 12px; margin-top: 4px; display: block;">
          仅更新当前后端进程内的 INTERNAL_API_KEY。容器重启后会回退为 <code>backend/.env.docker</code> 中的值，请同时保持二者一致。
        </n-text>
      </n-space>
    </n-card>

    <n-card title="节点管理">
    <n-space style="margin-bottom: 16px;" justify="space-between">
      <n-space>
        <n-button type="primary" @click="openCreate">
          <template #icon>
            <span style="font-size: 1em;">+</span>
          </template>
          新建节点
        </n-button>
      </n-space>
    </n-space>
    <div class="table-responsive">
      <n-data-table :columns="columns" :data="list" :loading="loading" />
    </div>
    <n-empty
      v-if="!loading && list.length === 0"
      description="暂无节点，点击上方「新建节点」添加"
      style="margin: 24px 0;"
    />
    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="modalTitle"
      style="width: 720px;"
      @after-leave="resetForm"
    >
      <n-form ref="formRef" :model="form" label-placement="left" label-width="110px">
        <n-form-item label="节点名称" path="name" required>
          <n-input v-model:value="form.name" placeholder="例如：香港 VLESS 01" />
        </n-form-item>
        <n-form-item label="地址" path="address" required>
          <n-input v-model:value="form.address" placeholder="域名或 IP，例如 hk1.example.com" />
        </n-form-item>
        <n-form-item label="端口" path="port" required>
          <n-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%" />
        </n-form-item>
        <n-form-item label="协议" path="protocol" required>
          <n-select
            v-model:value="form.protocol"
            :options="protocolOptions"
            placeholder="选择协议（VLESS/VMess/SS/Trojan 等）"
          />
        </n-form-item>
        <n-form-item label="绑定总套餐" path="group_ids">
          <n-select
            v-model:value="selectedGroupIds"
            :options="groupOptions"
            multiple
            clearable
            placeholder="选择总套餐（该总套餐下所有子套餐均可使用此节点）"
          />
        </n-form-item>
        <n-form-item label="排序" path="sort_order">
          <n-input-number
            v-model:value="form.sort_order"
            :min="0"
            style="width: 100%"
            placeholder="数值越小越靠前"
          />
        </n-form-item>
        <n-form-item label="启用" path="status">
          <n-switch v-model:value="form.status" :checked-value="1" :unchecked-value="0" />
        </n-form-item>
        <n-divider style="margin: 12px 0;">配置</n-divider>
        <n-form-item label="从节点链接解析">
          <n-space style="width: 100%;">
            <n-input
              v-model:value="rawLink"
              placeholder="粘贴 vless / vmess / ss / trojan / hy2 / socks 等链接，点击右侧按钮解析"
            />
            <n-button type="info" secondary @click="handleParseLink">
              自动识别
            </n-button>
          </n-space>
          <span class="form-hint">支持常见 vless://、vmess://、ss://、trojan://、hysteria2://(hy2://)、socks:// 等节点链接。</span>
        </n-form-item>
        <n-form-item label="节点配置 JSON" path="config" required>
          <n-input
            v-model:value="form.config"
            type="textarea"
            :rows="8"
            placeholder="根据协议填写节点 JSON 配置，后续订阅生成将从这里读取字段。"
          />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" :loading="submitLoading" @click="submit">
            {{ isEditing ? '保存' : '创建' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import {
  NAlert,
  NCard,
  NSpace,
  NButton,
  NDataTable,
  NTag,
  NText,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSwitch,
  NSelect,
  NDivider,
  NEmpty,
  useMessage,
  NPopconfirm
} from 'naive-ui';
import {
  getAdminNodes,
  postAdminNode,
  putAdminNode,
  deleteAdminNode,
  getAdminPlanGroups,
  getAdminInternalApiKey,
  updateAdminInternalApiKey
} from '@/api/admin';

const message = useMessage();
const list = ref([]);
const loading = ref(false);
const showModal = ref(false);
const submitLoading = ref(false);
const formRef = ref(null);
const editId = ref(null);
const rawLink = ref('');

const planGroups = ref([]);
const groupOptions = computed(() =>
  planGroups.value.map((g) => ({ label: g.name, value: g.id }))
);
const selectedGroupIds = ref([]);

// INTERNAL_API_KEY 设置
const internalApiKey = ref('');
const internalKeyLoading = ref(false);

const protocolOptions = [
  { label: 'VLESS', value: 'vless' },
  { label: 'VMess', value: 'vmess' },
  { label: 'Shadowsocks', value: 'shadowsocks' },
  { label: 'Trojan', value: 'trojan' },
  { label: 'Hysteria2', value: 'hysteria2' },
  { label: 'SOCKS', value: 'socks' },
  { label: 'HTTP 代理', value: 'http' },
  { label: 'WireGuard', value: 'wireguard' }
];

const form = ref(getDefaultForm());

function getDefaultForm() {
  return {
    name: '',
    address: '',
    port: 443,
    protocol: 'vless',
    config: '',
    status: 1,
    sort_order: 0
  };
}

const isEditing = computed(() => editId.value != null);
const modalTitle = computed(() => (isEditing.value ? '编辑节点' : '新建节点'));

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', minWidth: 100, maxWidth: 180, ellipsis: { tooltip: true } },
  { title: '地址', key: 'address', minWidth: 120, maxWidth: 200, ellipsis: { tooltip: true } },
  { title: '端口', key: 'port', width: 80 },
  { title: '协议', key: 'protocol', width: 90 },
  {
    title: '绑定总套餐',
    key: 'group_ids',
    minWidth: 140,
    maxWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) => {
      const ids = row.group_ids || [];
      if (!ids.length) return '未绑定';
      const names = ids
        .map((id) => planGroups.value.find((g) => g.id === id)?.name || `#${id}`)
        .join('、');
      return names;
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (row) =>
      h(
        NTag,
        { type: row.status ? 'success' : 'default' },
        { default: () => (row.status ? '启用' : '停用') }
      )
  },
  { title: '排序', key: 'sort_order', width: 80 },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    fixed: 'right',
    render: (row) =>
      h(
        NSpace,
        { size: 'small' },
        () => [
          h(
            NButton,
            { size: 'small', onClick: () => edit(row) },
            { default: () => '编辑' }
          ),
          h(
            NPopconfirm,
            {
              onPositiveClick: () => doDelete(row.id),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定删除该节点？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'error', tertiary: true },
                  { default: () => '删除' }
                )
            }
          )
        ]
      )
  }
];

async function fetchPlanGroups() {
  try {
    const res = await getAdminPlanGroups();
    planGroups.value = res.data || [];
  } catch (e) {
    message.error(e.message || '获取总套餐列表失败');
  }
}

async function fetchList() {
  loading.value = true;
  try {
    const res = await getAdminNodes();
    list.value = res.data || [];
  } catch (e) {
    message.error(e.message || '获取节点列表失败');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editId.value = null;
  form.value = getDefaultForm();
  selectedGroupIds.value = [];
  rawLink.value = '';
  showModal.value = true;
}

function resetForm() {
  form.value = getDefaultForm();
  selectedGroupIds.value = [];
  rawLink.value = '';
  editId.value = null;
}

function edit(row) {
  editId.value = row.id;
  form.value = {
    name: row.name,
    address: row.address,
    port: row.port,
    protocol: row.protocol,
    config: row.config,
    status: row.status,
    sort_order: row.sort_order
  };
  selectedGroupIds.value = Array.isArray(row.group_ids) ? [...row.group_ids] : [];
  rawLink.value = '';
  showModal.value = true;
}

async function submit() {
  if (!form.value.name || !form.value.address || !form.value.port || !form.value.protocol) {
    message.warning('请完整填写名称、地址、端口和协议');
    return;
  }
  if (!form.value.config) {
    message.warning('请填写节点配置 JSON');
    return;
  }

  submitLoading.value = true;
  const payload = {
    ...form.value,
    group_ids: selectedGroupIds.value
  };
  try {
    if (editId.value) {
      await putAdminNode(editId.value, payload);
      message.success('节点已更新');
    } else {
      await postAdminNode(payload);
      message.success('节点已创建');
    }
    showModal.value = false;
    await fetchList();
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    submitLoading.value = false;
  }
}

async function doDelete(id) {
  try {
    await deleteAdminNode(id);
    message.success('节点已删除');
    await fetchList();
  } catch (e) {
    message.error(e.message || '删除失败');
  }
}

function handleParseLink() {
  if (!rawLink.value) {
    message.warning('请先粘贴节点链接');
    return;
  }
  try {
    const parsed = parseNodeLink(rawLink.value.trim());
    form.value.name = form.value.name || parsed.name || form.value.name;
    form.value.address = parsed.address;
    form.value.port = parsed.port || 443;
    form.value.protocol = parsed.protocol;
    form.value.config = JSON.stringify(parsed.config, null, 2);
    message.success('节点链接解析成功，已填充基础字段');
  } catch (e) {
    message.error(e.message || '解析失败，请检查链接格式');
  }
}

function parseNodeLink(link) {
  const l = link.trim();
  if (l.startsWith('vless://')) return parseVlessLink(l);
  if (l.startsWith('vmess://')) return parseVmessLink(l);
  if (l.startsWith('ss://')) return parseSsLink(l);
  if (l.startsWith('trojan://')) return parseTrojanLink(l);
  if (l.startsWith('hysteria2://') || l.startsWith('hy2://')) return parseHy2Link(l);
  if (l.startsWith('socks://') || l.startsWith('socks5://')) return parseSocksLink(l);
  if (l.startsWith('http://') || l.startsWith('https://')) return parseHttpProxyLink(l);
   // WireGuard：优先支持自定义 wireguard:// / wg:// 链接，其它情况请手动填写 JSON
  if (l.startsWith('wireguard://') || l.startsWith('wg://')) return parseWireguardLink(l);
  throw new Error('不支持的节点协议');
}

function parseVlessLink(link) {
  const withoutScheme = link.slice('vless://'.length);
  const [main, hashPart] = withoutScheme.split('#');
  const name = hashPart ? decodeURIComponent(hashPart) : '';
  const url = new URL('http://' + main);
  const uuid = url.username;
  const address = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const params = url.searchParams;

  if (!uuid || !address) {
    throw new Error('VLESS 解析失败：UUID 或地址为空');
  }

  const security = params.get('security') || '';
  const flow = params.get('flow') || '';
  const sni = params.get('sni') || params.get('host') || '';
  const publicKey = params.get('pbk') || params.get('publickey') || '';
  const encryption = params.get('encryption') || 'none';
  const type = params.get('type') || 'tcp';

  const config = {
    uuid,
    security,
    flow,
    sni,
    publicKey,
    encryption,
    transport: type,
    rawQuery: params.toString()
  };

  return { protocol: 'vless', name, address, port, config };
}

function decodeBase64(str) {
  try {
    // 处理 URL-safe base64
    const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
    return atob(normalized);
  } catch (e) {
    throw new Error('Base64 解码失败');
  }
}

function parseVmessLink(link) {
  let body = link.slice('vmess://'.length).trim();
  body = body.replace(/\s/g, '');
  const jsonStr = decodeBase64(body);
  const obj = JSON.parse(jsonStr);

  const name = obj.ps || '';
  const address = obj.add;
  const port = Number(obj.port || 443);

  if (!address || !port || !obj.id) {
    throw new Error('VMess 链接缺少必要字段');
  }

  const config = { ...obj };
  return { protocol: 'vmess', name, address, port, config };
}

function parseSsLink(link) {
  let l = link.slice('ss://'.length);
  const [main, hashPart] = l.split('#');
  const name = hashPart ? decodeURIComponent(hashPart) : '';

  let userInfoHost;
  if (main.includes('@')) {
    userInfoHost = main;
  } else {
    const decoded = decodeBase64(main.split('?')[0]);
    userInfoHost = decoded;
  }

  const [userInfo, hostPortPart] = userInfoHost.split('@');
  if (!hostPortPart) throw new Error('SS 链接解析失败');

  const [method, password] = userInfo.split(':');
  const [host, portStr] = hostPortPart.split(':');
  const port = Number(portStr || 8388);

  if (!method || !password || !host) {
    throw new Error('SS 链接缺少必要字段');
  }

  const config = {
    method,
    password,
    plugin: '',
    plugin_opts: ''
  };

  return { protocol: 'shadowsocks', name, address: host, port, config };
}

function parseTrojanLink(link) {
  const withoutScheme = link.slice('trojan://'.length);
  const [main, hashPart] = withoutScheme.split('#');
  const name = hashPart ? decodeURIComponent(hashPart) : '';

  const url = new URL('http://' + main);
  const password = url.username;
  const address = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const params = url.searchParams;

  if (!password || !address) {
    throw new Error('Trojan 链接解析失败：password 或地址为空');
  }

  const sni = params.get('sni') || params.get('host') || '';
  const alpn = params.get('alpn') ? params.get('alpn').split(',') : [];
  const path = params.get('path') || '';

  const config = {
    password,
    sni,
    alpn,
    path,
    rawQuery: params.toString()
  };

  return { protocol: 'trojan', name, address, port, config };
}

function parseHy2Link(link) {
  const prefix = link.startsWith('hysteria2://') ? 'hysteria2://' : 'hy2://';
  const withoutScheme = link.slice(prefix.length);
  const [main, hashPart] = withoutScheme.split('#');
  const name = hashPart ? decodeURIComponent(hashPart) : '';

  const url = new URL('http://' + main);
  const token = url.username;
  const address = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const params = url.searchParams;

  const up = Number(params.get('upmbps') || params.get('up') || 0);
  const down = Number(params.get('downmbps') || params.get('down') || 0);
  const sni = params.get('sni') || '';
  const alpn = params.get('alpn') ? params.get('alpn').split(',') : [];

  if (!token || !address) {
    throw new Error('Hysteria2 链接解析失败：token 或地址为空');
  }

  const config = {
    password: token,
    up_mbps: up,
    down_mbps: down,
    sni,
    alpn,
    rawQuery: params.toString()
  };

  return { protocol: 'hysteria2', name, address, port, config };
}

function parseSocksLink(link) {
  const prefix = link.startsWith('socks5://') ? 'socks5://' : 'socks://';
  const withoutScheme = link.slice(prefix.length);
  const [main, hashPart] = withoutScheme.split('#');
  const name = hashPart ? decodeURIComponent(hashPart) : '';

  const url = new URL('http://' + main);
  const username = url.username || '';
  const password = url.password || '';
  const address = url.hostname;
  const port = url.port ? Number(url.port) : 1080;

  if (!address) {
    throw new Error('SOCKS 链接解析失败：地址为空');
  }

  const config = { username, password };
  return { protocol: 'socks', name, address, port, config };
}

function parseHttpProxyLink(link) {
  const url = new URL(link);
  const username = url.username || '';
  const password = url.password || '';
  const address = url.hostname;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  if (!address) {
    throw new Error('HTTP 代理链接解析失败：地址为空');
  }

  const config = {
    username,
    password,
    scheme: url.protocol.replace(':', '')
  };

  return { protocol: 'http', name: '', address, port, config };
}

// 这里采用简单的 wireguard://publicKey@host:port?privateKey=&allowedIPs=&mtu=&keepalive=&name= 写法
// 若实际链接格式不同，可在保存前手动调整 JSON
function parseWireguardLink(link) {
  const prefix = link.startsWith('wireguard://') ? 'wireguard://' : 'wg://';
  const withoutScheme = link.slice(prefix.length);
  const [main, hashPart] = withoutScheme.split('#');
  const nameFromHash = hashPart ? decodeURIComponent(hashPart) : '';

  const url = new URL('http://' + main);
  const publicKey = url.username || '';
  const address = url.hostname;
  const port = url.port ? Number(url.port) : 51820;
  const params = url.searchParams;

  if (!publicKey || !address) {
    throw new Error('WireGuard 链接解析失败：publicKey 或地址为空');
  }

  const privateKey = params.get('privateKey') || '';
  const allowedIPs = params.get('allowedIPs') || params.get('allowed_ips') || '0.0.0.0/0';
  const mtu = params.get('mtu') ? Number(params.get('mtu')) : null;
  const keepalive = params.get('keepalive') ? Number(params.get('keepalive')) : null;

  const config = {
    publicKey,
    privateKey,
    endpoint: `${address}:${port}`,
    allowedIPs,
    mtu,
    keepalive,
    rawQuery: params.toString()
  };

  const name = nameFromHash || '';

  return { protocol: 'wireguard', name, address, port, config };
}

onMounted(async () => {
  await refreshInternalKey();
  await Promise.all([fetchPlanGroups(), fetchList()]);
});

async function refreshInternalKey() {
  internalKeyLoading.value = true;
  try {
    const res = await getAdminInternalApiKey();
    internalApiKey.value = res.data?.value || '';
  } catch (e) {
    message.error(e.message || '获取 INTERNAL_API_KEY 失败');
  } finally {
    internalKeyLoading.value = false;
  }
}

async function saveInternalKey() {
  if (!internalApiKey.value) {
    message.warning('INTERNAL_API_KEY 不能为空');
    return;
  }
  internalKeyLoading.value = true;
  try {
    await updateAdminInternalApiKey(internalApiKey.value);
    message.success('INTERNAL_API_KEY 已更新（当前进程生效）');
  } catch (e) {
    message.error(e.message || '更新 INTERNAL_API_KEY 失败');
  } finally {
    internalKeyLoading.value = false;
  }
}
</script>

<style scoped>
.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--n-text-color-3);
}
</style>

