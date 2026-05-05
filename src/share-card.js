// =============================================================
// share-card.js — renders a 1080×1350 portrait "share card"
// from a SceneSpec + the whiteboard canvas. The card is the
// translation layer in static form: kid question on top, the
// drawing in the middle, the kid-voice reply, and a sticky
// note revealing how researchers would phrase the same thing.
// =============================================================

const W = 1080;
const H = 1350;
const PAD = 64;

const C = {
  paper:    '#FCEFD2',
  ink:      '#2D2622',
  inkSoft:  '#5C4A3F',
  accent:   '#E66363',
  sun:      '#FFD16B',
  sky:      '#7CB7D0',
  leaf:     '#6FB05C',
  sticky:   '#FFE4A8',
  wood:     '#b98e62',
  woodDark: '#8b6240',
  shadow:   'rgba(45,38,34,0.18)',
};

export async function renderShareCard(spec, whiteboardCanvas) {
  // make sure custom fonts are loaded before measuring/drawing
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.textBaseline = 'top';

  // === BACKGROUND: cream paper + faint grain + warm vignette ===
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(45,38,34,${(0.015 + Math.random() * 0.04).toFixed(3)})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  const vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.35, W / 2, H / 2, W * 0.85);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(45,38,34,0.12)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // === TOP BAR: wordmark + tagline ===
  let y = 56;
  ctx.font = '700 56px "Caveat", cursive';
  ctx.fillStyle = C.ink;
  ctx.fillText('wonder', PAD, y);
  const w1 = ctx.measureText('wonder').width;
  ctx.fillStyle = C.accent;
  ctx.fillText('lab', PAD + w1, y);
  const w2 = ctx.measureText('lab').width;
  ctx.fillStyle = C.sun;
  ctx.fillText('✦', PAD + w1 + w2 + 12, y);

  ctx.font = '500 20px "Nunito", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = C.inkSoft;
  ctx.fillText('asked by a kid · drawn by a researcher', W - PAD, y + 24);
  ctx.textAlign = 'left';

  // === BIG HANDWRITTEN QUESTION ===
  y = 160;
  ctx.font = '700 76px "Caveat", cursive';
  ctx.fillStyle = C.ink;
  const qText = `"${(spec.question || '…').replace(/^["“]|["”]$/g, '').trim()}"`;
  y = wrapText(ctx, qText, PAD, y, W - PAD * 2, 86, 2);

  // === WHITEBOARD ILLUSTRATION in a wooden frame ===
  y += 24;
  // cap the inner height so the page below has room for reply + sticky + footer
  const ratio   = whiteboardCanvas.height / whiteboardCanvas.width;  // ~720/1024 = 0.703
  const maxInH  = 500;
  const wantInW = W - PAD * 2;
  const innerH  = Math.min(maxInH, wantInW * ratio);
  const innerW  = innerH / ratio;
  const innerX  = (W - innerW) / 2;
  const FR = 18;  // wood thickness
  // shadow
  ctx.fillStyle = C.shadow;
  roundRect(ctx, innerX + 6, y + 8, innerW + FR * 2, innerH + FR * 2, 14);
  ctx.fill();
  // wood frame
  ctx.fillStyle = C.wood;
  roundRect(ctx, innerX - FR, y - FR, innerW + FR * 2, innerH + FR * 2, 14);
  ctx.fill();
  // inner cream backing (in case the SVG has transparent parts)
  ctx.fillStyle = '#FFFCEC';
  ctx.fillRect(innerX, y, innerW, innerH);
  // the whiteboard itself
  ctx.drawImage(whiteboardCanvas, innerX, y, innerW, innerH);
  // tiny screws in the corners
  for (const [sx, sy] of [[innerX - FR + 8, y - FR + 8], [innerX + innerW + FR - 8, y - FR + 8],
                          [innerX - FR + 8, y + innerH + FR - 8], [innerX + innerW + FR - 8, y + innerH + FR - 8]]) {
    ctx.fillStyle = C.woodDark;
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
  }
  y += innerH + FR + 28;

  // === IRIS REPLY (kid voice) ===
  ctx.font = '600 30px "Fredoka", sans-serif';
  ctx.fillStyle = C.ink;
  const replyText = (spec.answer?.kid || spec._reply || '').trim();
  if (replyText) {
    y = wrapText(ctx, replyText, PAD, y, W - PAD * 2, 42, 3);
    y += 22;
  }

  // === STICKY NOTE: "how researchers say it" — THE TRANSLATION REVEAL ===
  const open  = spec._research?.open_question;
  const bench = spec._research?.benchmark;
  if (open) {
    const FOOTER_RESERVE = 88;            // breathing room for the footer
    const stickyW = W - PAD * 2;
    const sx = PAD;
    const sy = y;
    const padTop = 24, padBot = 24, titleH = 44, titleGap = 12;
    const benchH = bench ? 36 : 0;
    const bodyMaxW = stickyW - 56;

    // figure out how many body lines we can fit before crashing into the footer
    ctx.font = '500 26px "Nunito", sans-serif';
    const bodyLineH = 36;
    const availForBody = (H - FOOTER_RESERVE) - sy - padTop - titleH - titleGap - benchH - padBot;
    const cap = Math.max(1, Math.floor(availForBody / bodyLineH));
    const bodyLines = Math.max(1, Math.min(cap, measureLines(ctx, open, bodyMaxW, cap)));
    const stickyH = padTop + titleH + titleGap + bodyLines * bodyLineH + benchH + padBot;

    ctx.save();
    // rotate slightly for tactile feel
    ctx.translate(sx + stickyW / 2, sy + stickyH / 2);
    ctx.rotate(-0.014);
    ctx.translate(-(sx + stickyW / 2), -(sy + stickyH / 2));
    // shadow
    ctx.fillStyle = C.shadow;
    roundRect(ctx, sx + 6, sy + 8, stickyW, stickyH, 6);
    ctx.fill();
    // sticky body
    ctx.fillStyle = C.sticky;
    roundRect(ctx, sx, sy, stickyW, stickyH, 6);
    ctx.fill();
    // a little dog-ear in the top-right
    ctx.fillStyle = 'rgba(45,38,34,0.06)';
    ctx.beginPath();
    ctx.moveTo(sx + stickyW - 24, sy);
    ctx.lineTo(sx + stickyW, sy);
    ctx.lineTo(sx + stickyW, sy + 24);
    ctx.closePath();
    ctx.fill();
    // tape strip on top
    ctx.fillStyle = 'rgba(124,183,208,0.55)';
    ctx.fillRect(sx + stickyW / 2 - 70, sy - 14, 140, 28);
    // title
    ctx.font = '700 36px "Caveat", cursive';
    ctx.fillStyle = C.ink;
    ctx.fillText('how researchers say it →', sx + 28, sy + padTop);
    // body
    ctx.font = '500 26px "Nunito", sans-serif';
    ctx.fillStyle = C.inkSoft;
    wrapText(ctx, open, sx + 28, sy + padTop + titleH + titleGap, bodyMaxW, bodyLineH, bodyLines);
    // benchmark stamp
    if (bench) {
      ctx.font = '700 20px "Nunito", sans-serif';
      ctx.fillStyle = C.accent;
      ctx.fillText(`— ${bench}`, sx + 28, sy + stickyH - padBot - 14);
    }
    ctx.restore();
    y += stickyH + 24;
  }

  // === FOOTER ===
  const FY = H - 56;
  ctx.font = '700 22px "Nunito", sans-serif';
  ctx.fillStyle = C.ink;
  ctx.fillText('the-wonderlab.pages.dev', PAD, FY);
  ctx.font = '500 20px "Nunito", sans-serif';
  ctx.fillStyle = C.inkSoft;
  ctx.textAlign = 'right';
  ctx.fillText('open scientific questions, in plain words', W - PAD, FY + 2);
  ctx.textAlign = 'left';

  return c;
}

function measureLines(ctx, text, maxW, maxLines = Infinity) {
  if (!text) return 0;
  const words = String(text).split(/\s+/).filter(Boolean);
  let line = '';
  let lines = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines++;
      if (lines >= maxLines) return lines;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines++;
  return Math.min(lines, maxLines);
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines = Infinity) {
  if (!text) return y;
  const words = String(text).split(/\s+/).filter(Boolean);
  let line = '';
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      if (lines >= maxLines - 1) {
        // truncate this final line with an ellipsis
        let cut = line + '…';
        while (ctx.measureText(cut).width > maxW && cut.length > 4) {
          cut = cut.slice(0, -2) + '…';
        }
        ctx.fillText(cut, x, y);
        return y + lineH;
      }
      ctx.fillText(line, x, y);
      y += lineH; lines++;
      line = words[i];
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, y);
    y += lineH;
  }
  return y;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// -----------------------------------------------------------
// Helpers for sharing — call these with the rendered canvas.
// -----------------------------------------------------------

export function downloadCanvasAsPng(canvas, filename = 'wonderlab.png') {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png', 0.95);
}

export async function copyCanvasToClipboard(canvas) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('clipboard images not supported in this browser');
  }
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png', 0.95));
  if (!blob) throw new Error('couldn’t encode image');
  await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
}

export async function nativeShareCanvas(canvas, { title, text } = {}) {
  if (!navigator.share) throw new Error('native share not available');
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png', 0.95));
  if (!blob) throw new Error('couldn’t encode image');
  const file = new File([blob], 'wonderlab.png', { type: 'image/png' });
  if (navigator.canShare && !navigator.canShare({ files: [file] })) {
    // fall back to text-only share
    await navigator.share({ title, text });
    return;
  }
  await navigator.share({ title, text, files: [file] });
}
