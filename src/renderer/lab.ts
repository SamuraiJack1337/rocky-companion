import type { CompanionMemory, FocusState, RelationshipStage } from '../shared/types';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`lab.html is missing #${id}`);
  return node as T;
}

function setStatus(node: HTMLElement, text: string, kind: 'ok' | 'err' | 'muted' = 'muted'): void {
  node.textContent = text;
  node.className = `status ${kind}`;
}

const focusPanel = el<HTMLDivElement>('focus-panel');
const focusCountdown = el<HTMLDivElement>('focus-countdown');
const focusLabel = el<HTMLDivElement>('focus-label');
const focusCopy = el<HTMLDivElement>('focus-copy');
const focusMinutes = el<HTMLInputElement>('focus-minutes');
const startFocusBtn = el<HTMLButtonElement>('start-focus');
const cancelFocusBtn = el<HTMLButtonElement>('cancel-focus');
const focusStatus = el<HTMLDivElement>('focus-status');
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-minutes]'));

const fistBumpBtn = el<HTMLButtonElement>('fist-bump');
const fistBumpStatus = el<HTMLDivElement>('fist-bump-status');

const calcTab = el<HTMLButtonElement>('calc-tab');
const convertTab = el<HTMLButtonElement>('convert-tab');
const calcPanel = el<HTMLDivElement>('calc-panel');
const convertPanel = el<HTMLDivElement>('convert-panel');
const calcExpression = el<HTMLInputElement>('calc-expression');
const calculateBtn = el<HTMLButtonElement>('calculate');
const calcResult = el<HTMLDivElement>('calc-result');
const convertValue = el<HTMLInputElement>('convert-value');
const convertFrom = el<HTMLSelectElement>('convert-from');
const convertTo = el<HTMLSelectElement>('convert-to');
const swapUnitsBtn = el<HTMLButtonElement>('swap-units');
const convertBtn = el<HTMLButtonElement>('convert');
const convertResult = el<HTMLDivElement>('convert-result');

const relationshipStage = el<HTMLSpanElement>('relationship-stage');
const relationshipSince = el<HTMLSpanElement>('relationship-since');
const relationshipProgress = el<HTMLDivElement>('relationship-progress');
const relationshipProgressFill = el<HTMLDivElement>('relationship-progress-fill');
const relationshipProgressLabel = el<HTMLDivElement>('relationship-progress-label');
const statLaunches = el<HTMLElement>('stat-launches');
const statObservations = el<HTMLElement>('stat-observations');
const statFocus = el<HTMLElement>('stat-focus');
const statBumps = el<HTMLElement>('stat-bumps');
const statSolves = el<HTMLElement>('stat-solves');
const resetMemoryBtn = el<HTMLButtonElement>('reset-memory');
const memoryStatus = el<HTMLDivElement>('memory-status');

let focusState: FocusState = { active: false, startedAt: null, endsAt: null, durationMinutes: 0 };
let expiryRefreshPending = false;

function clampFocusMinutes(value: number): number {
  return Math.min(180, Math.max(1, Math.round(Number.isFinite(value) ? value : 25)));
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function paintCountdown(): void {
  if (!focusState.active || !focusState.endsAt) {
    focusCountdown.textContent = `${String(clampFocusMinutes(Number(focusMinutes.value))).padStart(2, '0')}:00`;
    return;
  }
  const remaining = new Date(focusState.endsAt).getTime() - Date.now();
  focusCountdown.textContent = formatClock(remaining);
  if (remaining <= 0 && !expiryRefreshPending) {
    expiryRefreshPending = true;
    window.setTimeout(() => {
      void refreshFocus().finally(() => { expiryRefreshPending = false; });
    }, 600);
  }
}

function applyFocus(state: FocusState): void {
  focusState = state;
  focusPanel.classList.toggle('active', state.active);
  startFocusBtn.disabled = state.active;
  cancelFocusBtn.disabled = !state.active;
  focusMinutes.disabled = state.active;
  for (const button of presetButtons) button.disabled = state.active;

  if (state.active && state.endsAt) {
    focusLabel.textContent = `${state.durationMinutes}-minute session`;
    focusCopy.textContent = `Rocky keeps watch until ${new Date(state.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  } else {
    focusLabel.textContent = 'Choose a session';
    focusCopy.textContent = 'Rocky keeps watch while you work.';
  }
  paintCountdown();
}

async function refreshFocus(): Promise<void> {
  try {
    applyFocus(await window.rocky.getFocusState());
  } catch {
    setStatus(focusStatus, 'Could not read focus state.', 'err');
  }
}

async function startFocus(minutes: number): Promise<void> {
  const duration = clampFocusMinutes(minutes);
  focusMinutes.value = String(duration);
  startFocusBtn.disabled = true;
  setStatus(focusStatus, 'Starting session…');
  try {
    applyFocus(await window.rocky.startFocus(duration));
    setStatus(focusStatus, 'Focus session active. We work.', 'ok');
  } catch {
    setStatus(focusStatus, 'Could not start the session.', 'err');
    startFocusBtn.disabled = false;
  }
}

for (const button of presetButtons) {
  button.addEventListener('click', () => void startFocus(Number(button.dataset.minutes)));
}
focusMinutes.addEventListener('input', paintCountdown);
focusMinutes.addEventListener('change', () => {
  focusMinutes.value = String(clampFocusMinutes(Number(focusMinutes.value)));
  paintCountdown();
});
startFocusBtn.addEventListener('click', () => void startFocus(Number(focusMinutes.value)));
cancelFocusBtn.addEventListener('click', async () => {
  cancelFocusBtn.disabled = true;
  setStatus(focusStatus, 'Ending session…');
  try {
    applyFocus(await window.rocky.cancelFocus());
    setStatus(focusStatus, 'Session ended. We can begin again.', 'muted');
  } catch {
    setStatus(focusStatus, 'Could not cancel the session.', 'err');
    cancelFocusBtn.disabled = false;
  }
});
window.rocky.onFocusState((state) => {
  const completed = focusState.active && !state.active;
  const endedNaturally = completed && focusState.endsAt !== null &&
    new Date(focusState.endsAt).getTime() <= Date.now() + 1_000;
  applyFocus(state);
  if (endedNaturally) setStatus(focusStatus, 'Session complete. Strong work.', 'ok');
  if (completed) void refreshMemory();
});
window.setInterval(paintCountdown, 250);

fistBumpBtn.addEventListener('click', async () => {
  fistBumpBtn.disabled = true;
  setStatus(fistBumpStatus, 'Signal sent…');
  try {
    await window.rocky.fistBump();
    setStatus(fistBumpStatus, 'Fist bump. Celebration protocol complete.', 'ok');
    await refreshMemory();
  } catch {
    setStatus(fistBumpStatus, 'Rocky missed. Try again, question?', 'err');
  } finally {
    fistBumpBtn.disabled = false;
  }
});

function selectTool(tool: 'calculate' | 'convert'): void {
  const calculate = tool === 'calculate';
  calcTab.setAttribute('aria-selected', String(calculate));
  convertTab.setAttribute('aria-selected', String(!calculate));
  calcPanel.hidden = !calculate;
  convertPanel.hidden = calculate;
  (calculate ? calcExpression : convertValue).focus();
}

calcTab.addEventListener('click', () => selectTool('calculate'));
convertTab.addEventListener('click', () => selectTool('convert'));

async function calculate(): Promise<void> {
  const expression = calcExpression.value.trim();
  if (!expression) {
    calcResult.textContent = 'Enter an expression.';
    calcResult.classList.add('error');
    return;
  }
  calculateBtn.disabled = true;
  calcResult.textContent = 'Calculating…';
  calcResult.classList.remove('error');
  try {
    const result = await window.rocky.solveEngineering({ kind: 'calculate', expression });
    calcResult.textContent = result.ok ? (result.display ?? String(result.value)) : (result.error ?? 'Could not solve that.');
    calcResult.classList.toggle('error', !result.ok);
    if (result.ok) await refreshMemory();
  } catch {
    calcResult.textContent = 'Calculator unavailable.';
    calcResult.classList.add('error');
  } finally {
    calculateBtn.disabled = false;
  }
}

calculateBtn.addEventListener('click', () => void calculate());
calcExpression.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void calculate();
});

interface UnitGroup { family: string; label: string; units: Array<[string, string]> }
const UNIT_GROUPS: UnitGroup[] = [
  { family: 'length', label: 'Length', units: [['mm', 'Millimetres'], ['cm', 'Centimetres'], ['m', 'Metres'], ['km', 'Kilometres'], ['in', 'Inches'], ['ft', 'Feet'], ['yd', 'Yards'], ['mi', 'Miles']] },
  { family: 'mass', label: 'Mass', units: [['mg', 'Milligrams'], ['g', 'Grams'], ['kg', 'Kilograms'], ['oz', 'Ounces'], ['lb', 'Pounds']] },
  { family: 'time', label: 'Time', units: [['ms', 'Milliseconds'], ['s', 'Seconds'], ['min', 'Minutes'], ['h', 'Hours'], ['day', 'Days']] },
  { family: 'temperature', label: 'Temperature', units: [['c', 'Celsius (°C)'], ['f', 'Fahrenheit (°F)'], ['k', 'Kelvin (K)']] },
  { family: 'data', label: 'Data', units: [['b', 'Bytes'], ['kb', 'Kilobytes (KB)'], ['mb', 'Megabytes (MB)'], ['gb', 'Gigabytes (GB)'], ['kib', 'Kibibytes (KiB)'], ['mib', 'Mebibytes (MiB)'], ['gib', 'Gibibytes (GiB)']] },
];

function populateUnitSelect(select: HTMLSelectElement): void {
  for (const group of UNIT_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const [value, label] of group.units) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${label} (${value})`;
      option.dataset.family = group.family;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
}

function selectedFamily(select: HTMLSelectElement): string | undefined {
  return select.selectedOptions[0]?.dataset.family;
}

function alignTargetFamily(): void {
  const family = selectedFamily(convertFrom);
  if (selectedFamily(convertTo) === family) return;
  const match = Array.from(convertTo.options).find((option) => option.dataset.family === family);
  if (match) convertTo.value = match.value;
}

populateUnitSelect(convertFrom);
populateUnitSelect(convertTo);
convertFrom.value = 'km';
convertTo.value = 'mi';
convertFrom.addEventListener('change', alignTargetFamily);
swapUnitsBtn.addEventListener('click', () => {
  const from = convertFrom.value;
  convertFrom.value = convertTo.value;
  convertTo.value = from;
});

async function convertUnits(): Promise<void> {
  const value = Number(convertValue.value);
  if (!Number.isFinite(value)) {
    convertResult.textContent = 'Enter a finite number.';
    convertResult.classList.add('error');
    return;
  }
  convertBtn.disabled = true;
  convertResult.textContent = 'Converting…';
  convertResult.classList.remove('error');
  try {
    const result = await window.rocky.solveEngineering({
      kind: 'convert', value, from: convertFrom.value, to: convertTo.value,
    });
    convertResult.textContent = result.ok
      ? `${value} ${convertFrom.value} = ${result.display ?? result.value} ${convertTo.value}`
      : (result.error ?? 'Could not convert that.');
    convertResult.classList.toggle('error', !result.ok);
    if (result.ok) await refreshMemory();
  } catch {
    convertResult.textContent = 'Converter unavailable.';
    convertResult.classList.add('error');
  } finally {
    convertBtn.disabled = false;
  }
}

convertBtn.addEventListener('click', () => void convertUnits());
convertValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void convertUnits();
});

const STAGE_LABELS: Record<RelationshipStage, string> = {
  'first-contact': 'First contact', colleague: 'Colleague', buddy: 'Buddy', 'trusted-buddy': 'Trusted buddy',
};

function memoryScore(memory: CompanionMemory): number {
  return memory.launches * 2 + memory.observations + memory.focusSessionsCompleted * 8 +
    memory.fistBumps * 3 + memory.calculationsCompleted * 2;
}

function paintMemory(memory: CompanionMemory): void {
  const score = memoryScore(memory);
  const thresholds = memory.relationshipStage === 'first-contact' ? [0, 10]
    : memory.relationshipStage === 'colleague' ? [10, 35]
      : memory.relationshipStage === 'buddy' ? [35, 100] : [100, 100];
  const percentage = thresholds[0] === thresholds[1]
    ? 100
    : Math.min(100, Math.max(0, ((score - thresholds[0]) / (thresholds[1] - thresholds[0])) * 100));

  relationshipStage.textContent = STAGE_LABELS[memory.relationshipStage];
  const firstSeen = new Date(memory.firstSeenAt);
  relationshipSince.textContent = Number.isNaN(firstSeen.getTime())
    ? 'Shared history stored locally'
    : `Working together since ${firstSeen.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}`;
  relationshipProgress.setAttribute('aria-valuenow', String(Math.round(percentage)));
  relationshipProgressFill.style.width = `${percentage}%`;
  relationshipProgressLabel.textContent = memory.relationshipStage === 'trusted-buddy'
    ? 'Partnership level: amaze.'
    : `${Math.max(0, thresholds[1] - score)} partnership points to the next stage.`;
  statLaunches.textContent = String(memory.launches);
  statObservations.textContent = String(memory.observations);
  statFocus.textContent = String(memory.focusSessionsCompleted);
  statBumps.textContent = String(memory.fistBumps);
  statSolves.textContent = String(memory.calculationsCompleted);
}

async function refreshMemory(): Promise<void> {
  try {
    paintMemory(await window.rocky.getMemory());
  } catch {
    setStatus(memoryStatus, 'Could not load relationship history.', 'err');
  }
}

resetMemoryBtn.addEventListener('click', async () => {
  if (!window.confirm('Reset Rocky’s relationship counters and start again from first contact?')) return;
  resetMemoryBtn.disabled = true;
  setStatus(memoryStatus, 'Resetting local history…');
  try {
    paintMemory(await window.rocky.resetMemory());
    setStatus(memoryStatus, 'Relationship history reset.', 'ok');
  } catch {
    setStatus(memoryStatus, 'Could not reset relationship history.', 'err');
  } finally {
    resetMemoryBtn.disabled = false;
  }
});

el<HTMLButtonElement>('close-lab').addEventListener('click', () => window.rocky.closeSelf());

async function init(): Promise<void> {
  await Promise.all([refreshFocus(), refreshMemory()]);
}

void init();
