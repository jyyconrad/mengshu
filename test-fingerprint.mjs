import { authorityScopeFingerprint } from './dist/packages/core/src/domain/authority-scope-fingerprint.js';

// Test row from database
const row = {
  tenant_id: 'local',
  user_id: 'default',
  app_id: 'codex',
  project_id: 'body-learn',
  agent_id: 'default',
  namespace: 'working-context',
  visibility: 'private',
  workspace_id: 'body-learn',
  session_id: '',
  scope_fingerprint: '72a15a1ee4ad038e5151a1f35d4e5fbd72cf39000f16d50f7f978ce0aba54b34'
};

console.log('Database row:');
console.log('  workspace_id:', JSON.stringify(row.workspace_id));
console.log('  session_id:', JSON.stringify(row.session_id));
console.log('  scope_fingerprint:', row.scope_fingerprint);

// Build scope as the code does
const workspaceId = row.workspace_id === "" ? undefined : row.workspace_id;
const sessionId = row.session_id === "" ? undefined : row.session_id;

const scope1 = {
  tenantId: row.tenant_id,
  userId: row.user_id,
  appId: row.app_id,
  projectId: row.project_id,
  agentId: row.agent_id,
  namespace: row.namespace,
  visibility: row.visibility,
  ...(workspaceId ? { workspaceId } : {}),
  ...(sessionId ? { sessionId } : {}),
};

console.log('\nScope object (with conditional spread):');
console.log(JSON.stringify(scope1, null, 2));

const computed1 = authorityScopeFingerprint(scope1);
console.log('Computed fingerprint:', computed1);
console.log('Match?', computed1 === row.scope_fingerprint);

// Try with explicit empty string
const scope2 = {
  tenantId: row.tenant_id,
  userId: row.user_id,
  appId: row.app_id,
  projectId: row.project_id,
  agentId: row.agent_id,
  namespace: row.namespace,
  visibility: row.visibility,
  workspaceId: row.workspace_id,
  sessionId: row.session_id,
};

console.log('\nScope object (with explicit empty string):');
console.log(JSON.stringify(scope2, null, 2));

const computed2 = authorityScopeFingerprint(scope2);
console.log('Computed fingerprint:', computed2);
console.log('Match?', computed2 === row.scope_fingerprint);
