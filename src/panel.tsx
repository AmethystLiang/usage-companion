// No build step: Orca strips the types, compiles the JSX and resolves `./limits` when it loads.
import {
  atom,
  Badge,
  Button,
  EmptyState,
  Heading,
  plugin,
  Progress,
  read,
  Row,
  set,
  Stack,
  Text,
  ui,
  type PanelContext
} from 'orca'
import { formatReset, type LimitsSnapshot, type LimitsWindow } from './limits'

const REFRESH_MS = 60_000
const snapshot = atom<LimitsSnapshot | null>(null)
const failure = atom<string | null>(null)

async function refresh(): Promise<void> {
  try {
    set(snapshot, await plugin.request('limits.read', {}))
    set(failure, null)
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  }
}

/** Runs once before the first render; the timer stops when the panel closes. */
export function setup(ctx: PanelContext): void {
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void refresh()
}

const REASONS: Record<string, string> = {
  'no-accounts': 'Nenhuma conta do Claude configurada no Orca.',
  'no-usage': 'A conta ainda não tem dados de uso.',
  unreadable: 'Não consegui ler o arquivo de contas do Orca.'
}

function WindowRow({ label, window }: { label: string; window: LimitsWindow | null }) {
  if (!window) {
    return null
  }
  const percent = Math.min(100, Math.max(0, Math.round(window.percent)))
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text weight="semibold">{label}</Text>
        <Badge tone={percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'success'}>{percent}%</Badge>
      </Row>
      {ui.has('Progress') ? <Progress label={label} labelHidden value={percent} /> : null}
      <Text muted size="xs">Reseta {formatReset(window.resetsAt)}</Text>
    </Stack>
  )
}

export default function Panel() {
  const data = read(snapshot)
  const error = read(failure)

  if (!data && !error) {
    return <Text muted>Lendo limites…</Text>
  }
  if (!data || !data.ok) {
    const description = !data ? (error ?? '') : REASONS[data.reason]
    return <EmptyState icon="warning" title="Sem dados de limite" description={description} />
  }

  return (
    <Stack gap="md">
      <Heading>Limites do Claude</Heading>
      <WindowRow label="Sessão (5 horas)" window={data.fiveHour} />
      <WindowRow label="Semanal (7 dias)" window={data.sevenDay} />
      {data.limitedBy ? <Text tone="warning">Limitado por: {data.limitedBy}</Text> : null}
      {error ? <Text tone="danger" size="xs">Última atualização falhou: {error}</Text> : null}
      <Row justify="between">
        <Text muted size="xs">
          Atualiza a cada minuto
          {data.checkedAt ? ` · visto ${new Date(data.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </Text>
        <Button variant="ghost" icon="refresh" onPress={() => void refresh()}>
          Atualizar
        </Button>
      </Row>
    </Stack>
  )
}
