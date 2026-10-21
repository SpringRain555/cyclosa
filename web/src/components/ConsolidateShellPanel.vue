<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import {
  api,
  type ApiError,
  type ConsolidateShellOperation,
  type ConsolidateShellView,
} from '../api';
import { fill, t } from '../i18n/zh-TW';

const props = defineProps<{ slug: string; researchOpen: boolean | null }>();
const emit = defineEmits<{
  (event: 'error', error: ApiError | null): void;
  (event: 'started', runId: string): void;
  (event: 'runs-changed'): void;
  (event: 'open-changed', state: { slug: string; open: boolean | null }): void;
}>();

const current = ref<ConsolidateShellView | null>(null);
const busy = ref(false);
const loaded = ref(false);
const startBlocked = computed(() => busy.value || !loaded.value || props.researchOpen !== false);
const localError = ref<ApiError | null>(null);
const selected = computed(
  () =>
    current.value?.operations.filter(
      (operation) => operation.checked && operation.executable && operation.state === 'proposed',
    ).length ?? 0,
);
const serviceName = computed(() => {
  const service = current.value?.service;
  if (service === undefined) return '';
  const names = t.settings.connectionNames as Record<string, string>;
  const name = names[service.via] ?? service.via;
  return service.model.length === 0 ? name : name + ' · ' + service.model;
});
const statusLabels: Record<string, string> = {
  planning: t.consolidateShell.statusPlanning,
  reviewing: t.consolidateShell.statusReviewing,
  building: t.consolidateShell.statusBuilding,
  done: t.consolidateShell.statusDone,
  abandoned: t.consolidateShell.statusAbandoned,
};
const kindLabels: Record<string, string> = t.consolidateShell.kindLabels;
const dropReasonLabels: Record<string, string> = t.consolidateShell.dropReasons;

function report(error: ApiError | null): void {
  localError.value = error;
  emit('error', error);
}

async function reload(): Promise<void> {
  const slug = props.slug;
  const result = await api.consolidateShell(slug);
  if (slug !== props.slug) return;
  if (result.ok) {
    current.value = result.data;
    loaded.value = true;
    emit('open-changed', {
      slug,
      open:
        result.data !== null && result.data.status !== 'done' && result.data.status !== 'abandoned',
    });
    report(null);
  } else {
    loaded.value = false;
    emit('open-changed', { slug, open: null });
    report(result.error);
  }
}

async function plan(researchId: string): Promise<void> {
  busy.value = true;
  try {
    const result = await api.planConsolidateShell(props.slug, researchId);
    if (result.ok) {
      current.value = result.data;
      report(null);
    } else {
      report(result.error);
      await reload();
    }
  } finally {
    busy.value = false;
  }
}

async function start(): Promise<void> {
  if (startBlocked.value) return;
  busy.value = true;
  try {
    const currentShell = current.value;
    if (
      currentShell === null ||
      currentShell.status === 'done' ||
      currentShell.status === 'abandoned'
    ) {
      const result = await api.startConsolidateShell(props.slug);
      if (!result.ok) {
        report(result.error);
        return;
      }
      emit('open-changed', { slug: props.slug, open: true });
      emit('runs-changed');
      await reload();
      await plan(result.data.id);
      return;
    }
    await plan(currentShell.id);
  } finally {
    busy.value = false;
  }
}

async function setChecked(operation: ConsolidateShellOperation, checked: boolean): Promise<void> {
  const shell = current.value;
  if (shell === null) return;
  const result = await api.setConsolidateOpChecked(props.slug, shell.id, operation.id, checked);
  if (result.ok) {
    await reload();
    report(null);
  } else {
    report(result.error);
    await reload();
  }
}

async function execute(): Promise<void> {
  const shell = current.value;
  if (shell === null || selected.value === 0) return;
  busy.value = true;
  try {
    const result = await api.executeConsolidateShell(props.slug, shell.id);
    if (!result.ok) {
      report(result.error);
      return;
    }
    emit('runs-changed');
    emit('started', result.data.runId);
  } finally {
    busy.value = false;
  }
}

async function abandon(): Promise<void> {
  const shell = current.value;
  if (shell === null) return;
  const result = await api.abandonConsolidateShell(props.slug, shell.id);
  if (result.ok) {
    await reload();
    report(null);
    emit('runs-changed');
  } else {
    report(result.error);
  }
}

function dropReason(reason: string): string {
  return dropReasonLabels[reason] ?? reason;
}
function statusLabel(status: string): string {
  return statusLabels[status] ?? status;
}
function operationCanBeChecked(operation: ConsolidateShellOperation): boolean {
  return operation.kind === 'extract' && operation.executable && operation.state === 'proposed';
}

onMounted(() => void reload());
watch(
  () => props.slug,
  () => void reload(),
);
defineExpose({ reload });
</script>

<template>
  <section class="card consolidate-shell">
    <h2>{{ t.consolidateShell.title }}</h2>
    <p class="card-what">{{ t.consolidateShell.what }}</p>
    <p v-if="researchOpen === true" class="hint">{{ t.consolidateShell.researchOpen }}</p>
    <p v-if="current" class="hint">
      {{
        fill(current.service.costs ? t.consolidateShell.service : t.consolidateShell.serviceFree, {
          service: serviceName,
        })
      }}
    </p>
    <p v-if="localError" class="error-text">{{ localError.message }}</p>

    <template v-if="current === null">
      <button class="primary" :disabled="startBlocked" @click="start">
        {{ busy ? t.consolidateShell.planning : t.consolidateShell.start }}
      </button>
    </template>
    <template v-else>
      <p class="status">{{ statusLabel(current.status) }}</p>
      <button
        v-if="current.status !== 'done' && current.status !== 'abandoned'"
        class="secondary"
        :disabled="busy"
        @click="abandon"
      >
        {{ t.consolidateShell.abandon }}
      </button>
      <button
        v-if="current.status === 'done' || current.status === 'abandoned'"
        class="primary"
        :disabled="startBlocked"
        @click="start"
      >
        {{ t.consolidateShell.start }}
      </button>
      <template v-if="current.status === 'planning'">
        <button class="primary" :disabled="startBlocked" @click="start">
          {{
            busy
              ? t.consolidateShell.planning
              : current.operations.length === 0
                ? t.consolidateShell.plan
                : t.consolidateShell.retry
          }}
        </button>
      </template>

      <template v-if="current.coverage">
        <p class="coverage">
          {{ fill(t.consolidateShell.coverage, current.coverage) }}
        </p>
        <p v-if="current.dropped.count > 0" class="hint">
          {{ fill(t.consolidateShell.dropped, { n: current.dropped.count }) }}
        </p>
        <ul v-if="current.dropped.count > 0" class="drop-reasons">
          <li v-for="(count, reason) in current.dropped.reasons" :key="reason">
            {{ dropReason(String(reason)) }} · {{ count }}
          </li>
        </ul>
      </template>

      <section v-if="current.status === 'reviewing'" class="operation-list">
        <h3>{{ t.consolidateShell.operations }}</h3>
        <p v-if="current.operations.length === 0" class="muted">
          {{ t.consolidateShell.noOperations }}
        </p>
        <article v-for="operation in current.operations" :key="operation.id" class="operation">
          <label class="operation-row">
            <input
              v-if="operationCanBeChecked(operation)"
              type="checkbox"
              :checked="operation.checked"
              :disabled="busy"
              @change="setChecked(operation, ($event.target as HTMLInputElement).checked)"
            />
            <span v-else class="operation-placeholder" aria-hidden="true"></span>
            <span class="operation-copy">
              <strong>{{ kindLabels[operation.kind] ?? operation.kind }}</strong>
              <span>{{ operation.summary }}</span>
              <span class="muted">{{ fill(t.consolidateShell.why, { why: operation.why }) }}</span>
            </span>
            <span v-if="!operation.executable" class="muted unsupported">
              {{ t.consolidateShell.unsupported }}
            </span>
            <span v-else-if="operation.state !== 'proposed'" class="muted unsupported">
              {{ operation.state }}
            </span>
          </label>
        </article>

        <details class="single-evidence">
          <summary>{{ t.consolidateShell.singleEvidenceTitle }}</summary>
          <p class="muted">{{ t.consolidateShell.singleEvidenceTodo }}</p>
        </details>

        <div class="actions">
          <button class="primary" :disabled="busy || selected === 0" @click="execute">
            {{
              busy
                ? t.consolidateShell.executing
                : fill(t.consolidateShell.execute, { n: selected })
            }}
          </button>
        </div>
      </section>

      <p v-if="current.status === 'building'" class="hint">
        {{ t.consolidateShell.statusBuilding }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.consolidate-shell .status,
.consolidate-shell .coverage {
  color: var(--text-muted);
}

.operation-list {
  margin-top: 1rem;
}

.operation {
  border-top: 1px solid var(--line);
  padding: 0.75rem 0;
}

.operation-row {
  align-items: flex-start;
  display: flex;
  gap: 0.75rem;
}

.operation-row input {
  margin-top: 0.25rem;
}

.operation-copy {
  display: grid;
  flex: 1;
  gap: 0.25rem;
}

.operation-placeholder {
  flex: 0 0 1rem;
}

.unsupported {
  white-space: nowrap;
}

.drop-reasons {
  margin-block: 0.25rem 1rem;
}

.single-evidence {
  border-top: 1px solid var(--line);
  margin-top: 0.5rem;
  padding: 0.75rem 0;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}
</style>
