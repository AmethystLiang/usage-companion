import { Register } from 'claude-code';

let currentLimits = {
  fiveHourPercent: 0,
  fiveHourResetAt: '',
  sevenDayPercent: 0,
  sevenDayResetAt: '',
  status: 'unknown',
  limitedBy: '',
  lastUpdated: new Date().toISOString(),
};

async function fetchLimitsFromOrca(): Promise<any> {
  try {
    const home = process.env.HOME;
    if (!home) return null;
    const accountsPath = `${home}/.config/orca-claude-accounts/accounts.json`;

    const result = await $.fs.read(accountsPath);
    if (result?.ok) {
      const accounts = JSON.parse(result.text);
      if (accounts.accounts && accounts.accounts.length > 0) {
        const activeAccount = accounts.accounts.find((a: any) => a.id === accounts.active) || accounts.accounts[0];
        return activeAccount.usage || null;
      }
    }
  } catch (e) {
    console.error('Error reading accounts.json:', e);
  }
  return null;
}

function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${date.toLocaleTimeString()} (in ${hours}h ${mins}m)`;
}

function getStatusColor(percent: number): 'primary' | 'warning' | 'critical' {
  if (percent > 90) return 'critical';
  if (percent > 70) return 'warning';
  return 'primary';
}

let updateInterval: NodeJS.Timeout | null = null;

async function updateLimits() {
  const usage = await fetchLimitsFromOrca();
  if (usage) {
    currentLimits = {
      fiveHourPercent: usage.fiveHour?.percent || 0,
      fiveHourResetAt: usage.fiveHour?.resetsAt || '',
      sevenDayPercent: usage.sevenDay?.percent || 0,
      sevenDayResetAt: usage.sevenDay?.resetsAt || '',
      status: usage.status || 'unknown',
      limitedBy: usage.limitedBy || '',
      lastUpdated: new Date().toISOString(),
    };
    $.ui.status(`Claude: ${currentLimits.fiveHourPercent}% (5h), ${currentLimits.sevenDayPercent}% (7d)`);
  }
}

export const register: Register = (on, options) => {
  on('session.start', async () => {
    $.ui.open({ id: 'limits-tracker-pane', title: 'Claude Limits' });
    await updateLimits();
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      updateLimits();
    }, 60000);
  });

  on('ui.render', { component: 'Pane', requestId: 'limits-tracker-pane' }, (e, next) => {
    const limits = currentLimits;

    return e.ui.Box({ flex: 'col', gap: 'xs', padding: 'md' },
      e.ui.Text({ weight: 'bold', size: 'lg' }, 'Claude Rate Limits'),

      e.ui.Box({ flex: 'col', gap: '2xs' },
        e.ui.Box({ flex: 'row', between: true },
          e.ui.Text({ weight: 'semibold' }, '5-Hour Window'),
          e.ui.Text({ size: 'sm', weight: limits.limitedBy === 'five_hour' ? 'bold' : 'normal', color: limits.limitedBy === 'five_hour' ? 'critical' : 'secondary' }, `${limits.fiveHourPercent}%`)
        ),
        e.ui.Progress({ value: limits.fiveHourPercent, variant: getStatusColor(limits.fiveHourPercent) }),
        e.ui.Text({ size: 'xs', color: 'tertiary' }, `Resets: ${formatResetTime(limits.fiveHourResetAt)}`)
      ),

      e.ui.Box({ flex: 'col', gap: '2xs' },
        e.ui.Box({ flex: 'row', between: true },
          e.ui.Text({ weight: 'semibold' }, '7-Day Window'),
          e.ui.Text({ size: 'sm', weight: limits.limitedBy === 'seven_day' ? 'bold' : 'normal', color: limits.limitedBy === 'seven_day' ? 'critical' : 'secondary' }, `${limits.sevenDayPercent}%`)
        ),
        e.ui.Progress({ value: limits.sevenDayPercent, variant: getStatusColor(limits.sevenDayPercent) }),
        e.ui.Text({ size: 'xs', color: 'tertiary' }, `Resets: ${formatResetTime(limits.sevenDayResetAt)}`)
      ),

      e.ui.Box({ flex: 'col', gap: '2xs' },
        e.ui.Text({ weight: 'semibold', size: 'sm' }, 'Status'),
        e.ui.Text({ size: 'sm', color: limits.status === 'allowed' ? 'secondary' : 'critical' }, `${limits.status}${limits.limitedBy ? ` (limited by ${limits.limitedBy})` : ''}`),
        e.ui.Text({ size: 'xs', color: 'tertiary' }, `Last updated: ${new Date(limits.lastUpdated).toLocaleTimeString()}`)
      )
    );
  });
};
