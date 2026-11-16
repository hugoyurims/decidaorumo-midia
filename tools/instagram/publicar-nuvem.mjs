#!/usr/bin/env node
// Publica no Instagram a partir do GitHub Actions (sem depender do PC ligado).
//
//   node tools/instagram/publicar-nuvem.mjs [--agora] [--dry-run]
//
// Lê tools/instagram/agenda-nuvem.json: [{ id, canal, quando (ISO com fuso), video, capa, legenda, status?, mediaId? }]
// `video` e `capa` são URLs públicas (ex.: GitHub Pages do repositório decidaorumo-midia), subidas antes pelo
// PC com `node tools/instagram/agendar-nuvem.mjs`. Publica cada item pendente cujo horário chegou (até 6 h de
// atraso), esperando até o minuto marcado quando o workflow começa adiantado, e grava status/mediaId de volta
// no arquivo (o workflow faz commit).
//
// Credenciais só por variável de ambiente (segredos do repositório), nunca impressas:
//   IG_<CANAL>_TOKEN, IG_<CANAL>_USER, IG_<CANAL>_API ("facebook" → graph.facebook.com)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENDA = path.join(ROOT, 'tools', 'instagram', 'agenda-nuvem.json');
const agora = process.argv.includes('--agora');
const dryRun = process.argv.includes('--dry-run');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dorme = (ms) => new Promise((s) => setTimeout(s, ms));
// quantos minutos antes do horário uma execução pode começar e ficar esperando (o workflow do repositório público usa 300)
const JANELA = Number(process.env.JANELA_MIN || 30);

const agenda = JSON.parse(fs.readFileSync(AGENDA, 'utf8').replace(/^﻿/, ''));
const salvar = () => fs.writeFileSync(AGENDA, JSON.stringify(agenda, null, 2) + '\n');

const pendentes = agenda.filter((it) => {
  if (it.status === 'publicado') return false;
  const t = new Date(it.quando).getTime();
  return agora || (t <= Date.now() + JANELA * 60e3 && t >= Date.now() - 6 * 3600e3);
});
if (!pendentes.length) {
  log('Nada para publicar agora.');
  process.exit(0);
}

let falhou = false;
for (const it of pendentes.sort((a, b) => a.quando.localeCompare(b.quando))) {
  const K = it.canal.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const token = process.env[`IG_${K}_TOKEN`], user = process.env[`IG_${K}_USER`];
  const API = process.env[`IG_${K}_API`] === 'facebook' ? 'https://graph.facebook.com/v25.0' : 'https://graph.instagram.com/v25.0';
  if (!token || !user) {
    log(`ERRO ${it.id}: faltam os segredos IG_${K}_TOKEN / IG_${K}_USER`);
    falhou = true;
    continue;
  }
  const ig = async (method, p, params = {}) => {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const r = await fetch(`${API}/${p}${method === 'GET' ? `?${qs}` : ''}`, { method, ...(method === 'POST' ? { body: qs } : {}) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j;
  };
  try {
    log(`${it.id} (${it.canal}) marcado para ${it.quando}`);
    for (const u of [it.video, it.capa]) {
      const r = await fetch(u, { method: 'HEAD' });
      if (!r.ok) throw new Error(`arquivo não está público: ${u} (HTTP ${r.status})`);
    }
    // não publica duas vezes: um post com o mesmo começo de legenda (24 h) ou QUALQUER post da conta desde 3 h antes
    // do horário já conta como publicado (em 15/11 o Hugo postou à mão com outra legenda e a nuvem duplicou às 22:36)
    const jaNoAr = async () => {
      const de = new Date(it.quando).getTime() - 3 * 3600e3;
      const recentes = (await ig('GET', `${user}/media`, { fields: 'id,caption,timestamp', limit: '8' })).data || [];
      return recentes.find((m) => new Date(m.timestamp).getTime() >= de || ((m.caption || '').slice(0, 60) === it.legenda.slice(0, 60) && Date.now() - new Date(m.timestamp) < 24 * 3600e3));
    };
    const registra = (m) => { log(`Já está no ar (${m.id}); não publico de novo.`); Object.assign(it, { status: 'publicado', mediaId: m.id, publicadoEm: m.timestamp }); salvar(); };
    const igual = await jaNoAr();
    if (igual) { registra(igual); continue; }
    if (dryRun) {
      log('dry-run: ok, arquivos públicos e credenciais presentes.');
      continue;
    }
    // prepara o vídeo no Instagram antes de esperar (leva alguns minutos), para publicar no minuto marcado
    const { id: container } = await ig('POST', `${user}/media`, { media_type: 'REELS', video_url: it.video, cover_url: it.capa, caption: it.legenda, share_to_feed: 'true' });
    log('Container', container);
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 60 && status !== 'FINISHED'; i++) {
      await dorme(15000);
      status = (await ig('GET', container, { fields: 'status_code' })).status_code;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${status}`);
    }
    if (status !== 'FINISHED') throw new Error('o Instagram não terminou de processar em 15 min');
    const espera = new Date(it.quando).getTime() - Date.now();
    if (!agora && espera > 0) {
      log(`Pronto. Esperando ${Math.round(espera / 1000)} s até o horário marcado…`);
      await dorme(espera);
      const outro = await jaNoAr(); // o PC ou o Hugo podem ter publicado nesse meio-tempo
      if (outro) { registra(outro); continue; }
    }
    const { id: mediaId } = await ig('POST', `${user}/media_publish`, { creation_id: container });
    Object.assign(it, { status: 'publicado', mediaId, publicadoEm: new Date().toISOString() });
    salvar();
    log('Publicado!', mediaId);
  } catch (e) {
    log(`ERRO ${it.id}:`, e.message);
    Object.assign(it, { status: 'erro', erro: e.message, tentativa: new Date().toISOString() });
    salvar();
    falhou = true;
  }
}
process.exit(falhou ? 1 : 0);
