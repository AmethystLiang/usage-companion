# Limits Tracker

Acompanha seus limites de taxa do Claude em tempo real, mostrando:

- **5-Hour Window**: Uso em janelas de 5 horas, com horário de reset
- **7-Day Window**: Uso semanal com progresso visual
- **Status**: Indica se você está limited e por qual janela
- **Auto-update**: Atualiza a cada minuto automaticamente

O plugin lê dados do Orca (`.config/orca-claude-accounts/accounts.json`) e exibe em uma pane que fica ao lado do chat.

## Uso

Abre automaticamente ao iniciar a sessão. Mostra progresso com cores:
- Verde: Uso normal
- Amarelo: Acima de 70%
- Vermelho: Acima de 90%
