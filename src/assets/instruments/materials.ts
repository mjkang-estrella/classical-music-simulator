import { CanvasTexture, Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three';

function woodTexture(base: string, grain: string, w = 256, h = 512, flame = false): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * w;
    g.strokeStyle = grain;
    g.globalAlpha = 0.05 + Math.random() * 0.12;
    g.lineWidth = 0.5 + Math.random() * 2;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= h; y += 16) g.lineTo(x + Math.sin(y * 0.02 + i) * 3, y);
    g.stroke();
  }
  if (flame) {
    for (let y = 0; y < h; y += 6) {
      g.globalAlpha = 0.06 + 0.06 * Math.sin(y * 0.3);
      g.fillStyle = y % 12 < 6 ? '#ffffff' : '#000000';
      g.fillRect(0, y, w, 3);
    }
  }
  g.globalAlpha = 1;
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

let cache: ReturnType<typeof create> | null = null;

function create() {
  const spruce = woodTexture('#5c2a10', '#241004');
  const maple = woodTexture('#4a200c', '#1c0b03', 256, 512, true);
  const wood = woodTexture('#6b3a1c', '#2b1407');
  return {
    varnish: new MeshPhysicalMaterial({ color: new Color(spruce ? '#ffffff' : '#7a3a16'), map: spruce ?? undefined, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.35 }),
    varnishDark: new MeshPhysicalMaterial({ color: new Color(maple ? '#ffffff' : '#5a2710'), map: maple ?? undefined, roughness: 0.52, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.35 }),
    ebony: new MeshStandardMaterial({ color: '#0d0c0c', roughness: 0.35 }),
    string: new MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.3, metalness: 0.8 }),
    hair: new MeshStandardMaterial({ color: '#f1ece0', roughness: 0.9 }),
    bowStick: new MeshStandardMaterial({ color: '#4a1d0c', roughness: 0.35 }),
    brass: new MeshStandardMaterial({ color: '#e2b75c', roughness: 0.2, metalness: 1, side: DoubleSide }),
    brassDark: new MeshStandardMaterial({ color: '#b98a3a', roughness: 0.28, metalness: 1 }),
    silver: new MeshStandardMaterial({ color: '#e6e9ee', roughness: 0.16, metalness: 1 }),
    blackwood: new MeshPhysicalMaterial({ color: '#1a1412', roughness: 0.3, clearcoat: 0.6 }),
    bassoonWood: new MeshPhysicalMaterial({ color: '#7a2f12', map: wood ?? undefined, roughness: 0.35, clearcoat: 0.8 }),
    copper: new MeshStandardMaterial({ color: '#c07a45', roughness: 0.3, metalness: 1 }),
    skin: new MeshStandardMaterial({ color: '#d9ccb0', roughness: 0.8 }),
    chrome: new MeshStandardMaterial({ color: '#cfd3d8', roughness: 0.2, metalness: 1 }),
    black: new MeshStandardMaterial({ color: '#141416', roughness: 0.5 }),
    felt: new MeshStandardMaterial({ color: '#f0ece2', roughness: 1 }),
    stickWood: new MeshStandardMaterial({ color: '#c49a64', roughness: 0.5 }),
    harpWood: new MeshPhysicalMaterial({ color: '#c89a54', map: spruce ?? undefined, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }),
    gold: new MeshStandardMaterial({ color: '#e8c56b', roughness: 0.25, metalness: 1 }),
    cymbal: new MeshStandardMaterial({ color: '#d9b25e', roughness: 0.28, metalness: 1, side: DoubleSide }),
    drumShell: new MeshPhysicalMaterial({ color: '#2a0e0c', roughness: 0.3, clearcoat: 1 }),
    chair: new MeshStandardMaterial({ color: '#141414', roughness: 0.6 }),
    chairSeat: new MeshStandardMaterial({ color: '#1f1b1a', roughness: 0.9 }),
    stand: new MeshStandardMaterial({ color: '#111113', roughness: 0.4, metalness: 0.4 }),
    paper: new MeshStandardMaterial({ color: '#cfc8b6', roughness: 0.95 }),
  };
}

export type Materials = ReturnType<typeof create>;

export function materials(): Materials {
  return (cache ??= create());
}
