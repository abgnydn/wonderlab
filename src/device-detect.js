// =============================================================
// device-detect.js — sniff out the visitor's hardware + connection
// so the settings UI can suggest the right backend + model.
//
// What we look at (all feature-detected, never assume):
//   • navigator.gpu                    — does WebGPU exist?
//   • navigator.gpu.requestAdapter()   — can we actually get one?
//   • adapter.requestAdapterInfo()     — vendor / architecture
//   • navigator.deviceMemory           — RAM in GB (Chromium only; capped at 8)
//   • navigator.hardwareConcurrency    — logical cores (everywhere)
//   • navigator.connection.*           — effectiveType, downlink, saveData
//
// Returned tier semantics:
//   'cloud-only'  → no WebGPU at all, must use Claude/Gemini/local-server
//   'low'         → WebGPU works but tight: tiny model only (<1GB)
//   'mid'         → reasonable for ~1B-Instruct models (~900MB–1.2GB)
//   'high'        → can run ~3B-Instruct models well
// =============================================================

export async function detectCapabilities() {
  const cores = typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : null;

  // Chromium-only; don't infer absence as "low memory"
  const deviceMemoryGB = typeof navigator.deviceMemory === 'number'
    ? navigator.deviceMemory
    : null;

  // NetworkInformation API — Chromium-only too. Always feature-detect.
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const network = conn
    ? {
        effectiveType: conn.effectiveType ?? null,    // '4g' | '3g' | '2g' | 'slow-2g' | null
        downlink:      typeof conn.downlink === 'number' ? conn.downlink : null,
        rtt:           typeof conn.rtt === 'number' ? conn.rtt : null,
        saveData:      !!conn.saveData,
      }
    : { effectiveType: null, downlink: null, rtt: null, saveData: false };

  // WebGPU — must actually request an adapter; navigator.gpu can exist on
  // browsers that haven't initialised it (rare but real)
  let webgpu = { supported: false, adapter: null, isFallback: false };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        webgpu.supported = true;
        // adapter.info is the modern shape (synchronous getter); fall back to
        // requestAdapterInfo() if a runtime still uses the older async API.
        let info = adapter.info;
        if (!info && typeof adapter.requestAdapterInfo === 'function') {
          try { info = await adapter.requestAdapterInfo(); } catch {}
        }
        if (info) {
          webgpu.adapter = {
            vendor:       info.vendor       ?? null,
            architecture: info.architecture ?? null,
            device:       info.device       ?? null,
          };
          webgpu.isFallback = !!info.isFallbackAdapter;
        }
      }
    } catch (e) {
      // requestAdapter throws on a few browsers in private mode — treat as no-WebGPU
    }
  }

  return {
    cores,
    deviceMemoryGB,
    network,
    webgpu,
    tier:        pickTier({ cores, deviceMemoryGB, network, webgpu }),
    userAgent:   typeof navigator.userAgent === 'string' ? navigator.userAgent : '',
    isMobile:    /Mobi|Android|iPhone|iPad/.test(navigator.userAgent || ''),
  };
}

function pickTier({ cores, deviceMemoryGB, network, webgpu }) {
  if (!webgpu.supported || webgpu.isFallback) return 'cloud-only';

  // saveData mode = user is on a metered connection, do NOT recommend a giant
  // download even if their machine is beefy
  if (network.saveData) return 'low';

  // very-slow connections → small model only
  if (network.effectiveType === '2g' || network.effectiveType === 'slow-2g') return 'low';

  // we may not know memory at all (Firefox/Safari) — be conservative
  const knownMem = typeof deviceMemoryGB === 'number' ? deviceMemoryGB : null;

  if (knownMem != null) {
    if (knownMem <= 4) return 'low';
    if (knownMem <= 6) return 'mid';
    return 'high';                                                  // 8GB cap means "8GB or more"
  }

  // Unknown memory — fall back to cores. iPhones report 4 cores; M-series Macs report 8+.
  if (cores != null && cores >= 8 && network.effectiveType === '4g') return 'high';
  if (cores != null && cores >= 4) return 'mid';
  return 'low';
}

// -----------------------------------------------------------
// Recommendation: maps capabilities → a suggested backend + (for WebLLM)
// a specific model_id from the verified MLC catalogue.
// -----------------------------------------------------------

export const WEBLLM_MODELS = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B', sizeMB:  945, lowResource: true  },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', sizeMB:  879, lowResource: true  },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B', sizeMB: 1630, lowResource: true  },
  { id: 'gemma-2-2b-it-q4f16_1-MLC',         label: 'Gemma 2 2B',   sizeMB: 1895, lowResource: false },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', sizeMB: 2264, lowResource: true  },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen2.5 3B',   sizeMB: 2505, lowResource: true  },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 mini', sizeMB: 3672, lowResource: false },
];

export function recommend(caps) {
  // Default recommendation is Gemma 4 31B on AI Studio: open weights
  // (Apache 2.0), multimodal, native function calling, free tier with
  // no card. The SVG-drawing quality on 31B beats any browser-runnable
  // model, and the user keeps full optionality — WebLLM and LM Studio
  // stay one click away for offline use.
  //
  // No WebGPU at all → cloud is the only path anyway.
  if (caps.tier === 'cloud-only') {
    return {
      backend: 'gemma',
      reason:  caps.webgpu.supported
        ? 'your browser only offers a fallback GPU — Gemma 4 31B in the cloud is the cleanest path'
        : 'WebGPU isn\'t available here — Gemma 4 31B on AI Studio (free, no card) is the cleanest path',
      drawIllustrations: true,
      webllmModel: null,
    };
  }

  // WebGPU is here, so the user could run a model in-browser — but
  // the best-quality answer with full SVG illustration still comes
  // from Gemma 4 31B on AI Studio. Offer that as the recommendation;
  // surface WebLLM as the secondary "fully offline" option via the
  // picker.
  const reasonByTier = {
    low:  'Gemma 4 31B on AI Studio (free, no card) gives a far cleaner answer than what fits on this machine',
    mid:  'Gemma 4 31B on AI Studio (free, no card) — best quality; or pick WebLLM below to stay fully offline',
    high: 'Gemma 4 31B on AI Studio (free, no card) — best quality; this machine can also run WebLLM offline',
  };

  return {
    backend: 'gemma',
    reason:  reasonByTier[caps.tier] || reasonByTier.mid,
    drawIllustrations: true,
    webllmModel: null,
  };
}

// Pretty-print one-line summary, for the settings UI banner.
export function describeCapabilities(caps) {
  const bits = [];
  bits.push(caps.webgpu.supported
    ? (caps.webgpu.isFallback ? 'WebGPU (fallback)' : 'WebGPU ✓')
    : 'no WebGPU');
  if (caps.deviceMemoryGB != null) bits.push(`${caps.deviceMemoryGB}GB RAM`);
  if (caps.cores != null)          bits.push(`${caps.cores}-core CPU`);
  if (caps.network.effectiveType)  bits.push(caps.network.effectiveType);
  if (caps.network.saveData)       bits.push('data-saver on');
  return bits.join(' · ');
}
