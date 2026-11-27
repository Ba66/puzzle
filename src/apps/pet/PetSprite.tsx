import { useId } from 'react';
import { motion } from 'motion/react';
import type { PetExpression, PetFsmState } from './brain.ts';

export interface PetSpriteProps {
  expression: PetExpression;
  eyeOffsetX: number;
  eyeOffsetY: number;
  blinking: boolean;
  flailing: boolean;
  wireframeFlashActive: boolean;
  fsm: PetFsmState;
  facing: -1 | 0 | 1;
  widthPx: number;
  heightPx: number;
}

const capsuleEye = 'M-4-9H4V-7H6V7H4V9H-4V7H-6V-7H-4Z';
const ringEye = 'M-5-10H5V-8H8V8H5V10H-5V8H-8V-8H-5ZM-3-5V5H3V-5Z';
const faces = {
  neutral: {
    left: capsuleEye, right: capsuleEye,
    mouth: 'M-4 0H-2V2H2V0H4V3H2V4H-2V3H-4Z',
  },
  curious: {
    left: 'M-4-7H4V-5H6V5H4V7H-4V5H-6V-5H-4Z',
    right: 'M-4-11H5V-9H7V7H5V9H-5V7H-7V-6H-4Z',
    mouth: 'M-2-1H2V0H4V5H2V6H-2V5H-4V0H-2ZM-1 1V4H1V1Z',
  },
  squint: {
    left: 'M-7-8H-4L7-1V2L-4 9H-7V5L3 1L-7-4Z',
    right: 'M7-8H4L-7-1V2L4 9H7V5L-3 1L7-4Z',
    mouth: 'M-5 3H-3V1H3V3H5V5H2V3H-2V5H-5Z',
  },
  glare: {
    left: 'M-7-8H-2L7-4V-1L-7-5ZM-6-1L6 2V8H-6Z',
    right: 'M7-8H2L-7-4V-1L7-5ZM6-1L-6 2V8H6Z',
    mouth: 'M-5 1H5V4H-5Z',
  },
  pout: {
    left: 'M-4-6H5V-4H3V7H-3V5H-5V-4H-4Z',
    right: 'M-3-8H6V-6H4V7H-2V5H-4V-6H-3Z',
    mouth: 'M-4-1H2V0H4V2H2V3H4V5H2V6H-4V4H1V1H-4Z',
  },
  panic: {
    left: ringEye, right: ringEye,
    mouth: 'M-7 3H-5V0H-1V2H2V0H5V3H7V7H-7Z',
  },
  dizzy: {
    left: 'M-8-8H8V8H-8V-3H3V3H-3V0H0V-1H-5V5H5V-5H-8Z',
    right: 'M-7-8H-4L0-3L4-8H7V-5L3 0L7 5V8H4L0 3L-4 8H-7V5L-3 0L-7-5Z',
    mouth: 'M-5 0H-1V3H4V1H6V5H-3V2H-5Z',
  },
  shy: {
    left: 'M-8 6V2H-5V-2H-2V-5H2V-2H5V2H8V6H4V3H1V0H-1V3H-4V6Z',
    right: 'M-8 6V2H-5V-2H-2V-5H2V-2H5V2H8V6H4V3H1V0H-1V3H-4V6Z',
    mouth: 'M-5 0H5V3H3V5H-3V3H-5Z',
  },
  splat: {
    left: 'M-9-4H8V-2H11V2H8V5H-9V3H-11V-2H-9Z',
    right: 'M-8-4H9V-2H11V3H9V5H-8V2H-11V-2H-8Z',
    mouth: 'M-9 0H-6V3H-3V1H3V3H6V0H9V5H7V6H2V4H-2V6H-7V5H-9Z',
  },
  annoyed: {
    left: 'M-8-3H7V0H4V5H-4V3H-6V0H-8Z',
    right: 'M-7-3H8V0H5V5H-3V3H-5V0H-7Z',
    mouth: 'M-5 1H4V3H-5Z',
  },
} satisfies Record<PetExpression, { left: string; right: string; mouth: string }>;

const eyeSpring = { type: 'spring', stiffness: 400, damping: 31 } as const;

export function PetSprite({
  expression, eyeOffsetX, eyeOffsetY, blinking, flailing, wireframeFlashActive,
  fsm, facing, widthPx, heightPx,
}: PetSpriteProps) {
  const id = useId();
  const paint = (name: string) => `url(#${id}-${name})`;
  const face = faces[expression];
  const shy = expression === 'shy';
  const splat = expression === 'splat';
  const panic = expression === 'panic';
  const hopping = fsm === 'SUMMON_MOVE';
  const airborne = fsm === 'DRAGGED' || fsm === 'FALLING' || hopping || fsm.startsWith('INTRO') && fsm !== 'INTRO_RECOVER';
  const antennaColor = wireframeFlashActive ? '#34d399'
    : expression === 'curious' ? '#fbbf24'
    : shy ? '#f472b6'
    : panic || expression === 'annoyed' || expression === 'glare' ? '#fb7185'
    : '#38bdf8';
  const eyeColor = shy ? '#ffd3eb' : panic ? '#fff0df' : '#cefcff';
  const closed = blinking && !splat && !panic && expression !== 'squint';
  const armAngle = splat ? 69 : flailing || panic ? 145 : shy ? -23 : hopping ? 22 : 9;

  return (
    <svg width={widthPx} height={heightPx} viewBox="0 0 110 130" overflow="visible"
      role="img" aria-label="小桌宠 AI" className="block overflow-visible">
      <defs>
        <linearGradient id={`${id}-shell`} x2="0.72" y2="1">
          <stop stopColor="#f4fbff" />
          <stop offset=".39" stopColor="#b7d4e9" />
          <stop offset=".72" stopColor="#7997b9" />
          <stop offset="1" stopColor="#394e76" />
        </linearGradient>
        <linearGradient id={`${id}-alloy`} x2="0.9" y2="1">
          <stop stopColor="#a4cedc" />
          <stop offset=".53" stopColor="#657aab" />
          <stop offset="1" stopColor="#222c4d" />
        </linearGradient>
        <linearGradient id={`${id}-seam`} x2="0" y2="1">
          <stop stopColor="#ecfaff" /><stop offset="1" stopColor="#3b537b" />
        </linearGradient>
        <linearGradient id={`${id}-visor`} x2="0.38" y2="1">
          <stop stopColor="#1f3450" /><stop offset=".34" stopColor="#0b1120" />
          <stop offset=".82" stopColor="#080f21" /><stop offset="1" stopColor="#192641" />
        </linearGradient>
        <linearGradient id={`${id}-glare`} x2="0.66" y2="1">
          <stop stopColor="#c9efff" stopOpacity=".31" /><stop offset="1" stopColor="#82acdb" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-orb`} cx=".32" cy=".28" r=".72">
          <stop stopColor="#f1fdff" /><stop offset="1" stopColor={antennaColor} />
        </radialGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop stopColor="#040814" stopOpacity=".92" /><stop offset="1" stopColor="#050812" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-screen`}>
          <rect x="26" y="44" width="58" height="52" rx="17" />
        </clipPath>
      </defs>

      <g data-part="shadow" opacity={airborne ? .28 : .78}>
        <ellipse cx="55" cy="127" rx={airborne ? 19 : 45} ry={airborne ? 2.6 : 5.2} fill={paint('shadow')} />
      </g>

      <g data-part="legs">
        {([-1, 1] as const).map((side) => (
          <g key={side} transform={`translate(${55 + side * 19} 106) rotate(${hopping ? -side * 22 : side * 5})`}>
            <g className={flailing ? side === -1 ? 'pet-kick' : 'pet-kick pet-kick-offset' : undefined}>
              <path d="M-7-3Q-8 0-8 5L-9 11Q-9 17-4 18H6Q11 17 11 12Q11 7 6 7L5-3Z"
                fill={paint('alloy')} stroke="#283d60" strokeWidth="1.6" />
              <path d="M-7 13Q1 16 9 13M-5 5L4 5" fill="none" stroke="#a2d3eb" strokeOpacity=".6" strokeLinecap="round" />
            </g>
          </g>
        ))}
      </g>

      <g data-part="arms">
        {([-1, 1] as const).map((side) => (
          <g key={side} transform={`translate(${55 + side * 36} 78) rotate(${-side * armAngle})`}>
            <g className={flailing ? side === -1 ? 'pet-flail' : 'pet-flail pet-flail-offset' : undefined}>
              <path d="M0-4Q-7-4-7 4L-6 17Q-6 22 0 23Q7 23 7 16L7 5Q7-4 0-4Z"
                fill={paint('alloy')} stroke="#30466d" strokeWidth="1.5" />
              <path d="M-4 14Q0 16 4 14M-4 17Q0 19 3 17" fill="none" stroke="#b4e8fb" strokeOpacity=".68" />
            </g>
          </g>
        ))}
      </g>

      <g data-part="antenna" transform="translate(56 37)">
        <g className={flailing ? 'pet-antenna pet-antenna-alert' : 'pet-antenna'}>
          <path d="M0 1C-2-8 1-15 7-20C11-23 18-23 20-28" fill="none" stroke="#243859" strokeWidth="5" strokeLinecap="round" />
          <path d="M0 1C-2-8 1-15 7-20C11-23 18-23 20-28" fill="none" stroke="#b8dced" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="21" cy="-29" r="11" fill={antennaColor} opacity=".15" />
          <circle cx="21" cy="-29" r="6.5" fill={paint('orb')} stroke={antennaColor} strokeWidth="1.4"
            style={{ filter: `drop-shadow(0 0 4px ${antennaColor})` }} />
          <circle cx="19.2" cy="-30.7" r="1.35" fill="#fff" opacity=".88" />
        </g>
      </g>

      <g data-part="body-shell">
        <rect x="10" y="57" width="14" height="27" rx="6" fill={paint('alloy')} stroke="#3c557b" strokeWidth="1.5" />
        <rect x="86" y="57" width="14" height="27" rx="6" fill={paint('alloy')} stroke="#3c557b" strokeWidth="1.5" />
        <path d="M13.5 64V74M96.5 64V74" stroke="#b5eeff" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M45 33H65Q69 33 70 38H40Q41 33 45 33Z" fill={paint('alloy')} stroke="#6a88a8" />
        <path d="M45 35H65" stroke="#e1f4ff" strokeOpacity=".68" />
        <path d="M52 36C32 36 22 42 19 55C16 64 16 83 19 94C23 108 35 114 55 114C76 114 88 108 91 94C94 83 94 64 91 55C88 42 78 36 58 36Z"
          fill={paint('shell')} stroke={paint('seam')} strokeWidth="1.6" />
        <path d="M22 58C25 45 37 40 51 39M26 53C30 47 36 45 44 44" fill="none" stroke="#f3fcff"
          strokeOpacity=".76" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M22 94C26 106 40 110 55 110C70 110 84 106 88 94" fill="none" stroke="#385374" strokeOpacity=".65" />
        <path d="M32 101H40M32 104H37M70 101H78M73 104H78" stroke="#405c82" strokeOpacity=".8" strokeWidth="1.25" strokeLinecap="round" />
        <rect x="48" y="101" width="14" height="6" rx="3" fill="#304c6b" stroke="#9eb9d3" strokeWidth=".6" />
        <path d="M52 104H58" stroke={antennaColor} strokeWidth="1.4" strokeLinecap="round" />
      </g>

      <g data-part="faceplate">
        <rect x="24" y="42" width="62" height="56" rx="19" fill="#304d70" stroke="#c5d9ec" strokeWidth="1.15" />
        <rect x="26" y="44" width="58" height="52" rx="17" fill={paint('visor')} stroke="#15273f" strokeWidth="1.3" />
        <path d="M31 60Q32 48 45 47H68Q75 47 78 51C61 50 50 54 37 61Q33 63 31 60Z" fill={paint('glare')} />
        <path d="M37 92Q42 94 52 94H63Q72 94 76 90" fill="none" stroke="#9ed3ff" strokeOpacity=".23" />
        <path d="M76 58H79M77 61H79" fill="none" stroke="#6f9cc5" strokeOpacity=".55" strokeLinecap="round" />
      </g>

      <g data-part="pixel-eyes" data-expression={expression} clipPath={paint('screen')}>
        <motion.g animate={{ x: eyeOffsetX * 4 + facing * .9, y: eyeOffsetY * 3 }} transition={eyeSpring}>
          <g fill={eyeColor} fillRule="evenodd" className={panic ? 'pet-eye-jitter' : undefined}
            style={{ filter: `drop-shadow(0 0 3px ${shy ? '#f472b6' : '#43d6fc'})` }}>
            <g transform="translate(43 68)">
              <path d={closed ? 'M-6-1H6V1H-6Z' : face.left} className={expression === 'dizzy' && !closed ? 'pet-eye-spin' : undefined} />
            </g>
            <g transform="translate(67 68)">
              <path d={closed ? 'M-6-1H6V1H-6Z' : face.right} className={expression === 'dizzy' && !closed ? 'pet-eye-spin pet-eye-spin-reverse' : undefined} />
            </g>
            <path d={face.mouth} transform={`translate(${expression === 'pout' ? 52 : 55} 81)`} />
          </g>
          {(shy || expression === 'pout' || splat) && (
            <path d={splat ? 'M29 78H37V80H29ZM31 82H36V84H31ZM73 78H81V80H73ZM74 82H79V84H74Z'
              : 'M33 79H35V83H33ZM37 79H39V83H37ZM71 79H73V83H71ZM75 79H77V83H75Z'}
              fill={splat ? '#a9f5ff' : '#fa8fb9'} opacity=".86" />
          )}
        </motion.g>
      </g>

      {wireframeFlashActive && (
        <g data-part="wireframe-overlay" fill="none" stroke="#00ffaa" strokeWidth="1.25"
          style={{ filter: 'drop-shadow(0 0 3px #00ffaa)' }}>
          <path d="M20 58L31 42L48 36H63L80 42L91 58V94L79 107L64 114H46L31 107L19 94ZM19 58H91M19 73H91M19 89H91M30 104H81M48 36L37 59V91L46 114M63 36L74 59V91L64 114M55 37V113" />
          <path d="M3 62V49H14M96 95H106V82M8 96H17M94 49H104M21 74H89" />
          <rect x="12" y="80" width="38" height="11" fill="#062027" stroke="none" opacity=".9" />
          <rect x="73" y="52" width="26" height="10" fill="#062027" stroke="none" opacity=".9" />
          <text x="15" y="88" fill="#dbfff4" stroke="none" fontFamily="monospace" fontSize="9">0x2A</text>
          <text x="75" y="60" fill="#dbfff4" stroke="none" fontFamily="monospace" fontSize="8">MEM</text>
        </g>
      )}
    </svg>
  );
}
