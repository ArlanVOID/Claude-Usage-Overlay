<p align="center"><img src="logo.png" width="96" alt="logo"></p>

# Claude Usage Overlay

Overlay para Windows que mostra, sempre por cima dos outros aplicativos, os mesmos dados do comando `/usage` do Claude Code: uso da sessão atual (5h), limites semanais, limites por modelo e créditos extras — com contagem regressiva até cada reset.

## Recursos

- **Sempre no topo**, inclusive sobre apps em tela cheia sem borda
- **Arraste livremente** pela tela — a posição é lembrada
- **Minimizar** para uma barrinha compacta (S = sessão, W = semanal)
- **Atualização automática** (30s a 10 min) e logo após cada reset diário/semanal
- **Pausar** a atualização dos dados de uso
- Barras com cor por nível: verde, amarelo (≥70%) e vermelho (≥90%)
- Ícone na bandeja: mostrar/ocultar, atualizar, pausar, intervalo, iniciar com o Windows, sair

## Requisitos

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://claude.com/claude-code) com login feito (o overlay lê `~/.claude/.credentials.json`)

## Instalação

```bash
git clone https://github.com/ArlanVOID/Claude-Usage-Overlay.git
cd Claude-Usage-Overlay
npm install
npm run shortcut   # cria o atalho "Claude Usage Overlay" com o ícone
```

## Uso

- Dê dois cliques em **Claude Usage Overlay** (atalho) ou em `Iniciar Overlay.vbs`
- Ou rode `npm start`

Se o login expirar, o overlay avisa — basta abrir o Claude Code para renovar.

## Como funciona

O overlay consulta o mesmo endpoint que o `/usage` usa (`api.anthropic.com/api/oauth/usage`), autenticado com o token OAuth do Claude Code. O token nunca é renovado ou alterado pelo overlay, e nenhum dado é enviado para outro lugar.
