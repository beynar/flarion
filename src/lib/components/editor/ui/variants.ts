/** The chrome's button looks, on the app's Notion tokens (28px controls, 6px radius, hover wash). */
import { cn } from './cn.ts';

const base =
	'inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none rounded-[6px] border border-transparent text-sm font-medium outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/40 disabled:pointer-events-none disabled:opacity-50';

const variants = {
	default: 'bg-[color:var(--app-accent)] text-[#fff] hover:opacity-90',
	secondary: 'bg-[color:var(--app-active)] text-[color:var(--app-text)] hover:opacity-90',
	outline: 'border-[color:var(--app-hairline-strong)] hover:bg-[color:var(--app-hover)]',
	ghost: 'hover:bg-[color:var(--app-hover)] aria-expanded:bg-[color:var(--app-hover)]'
} as const;

const sizes = {
	default: 'h-7 gap-1.5 px-2',
	xs: 'h-6 gap-1 px-2 text-xs',
	sm: 'h-7 gap-1 px-2',
	icon: 'size-7',
	'icon-xs': 'size-6',
	'icon-sm': 'size-7'
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export const buttonVariants = ({ variant = 'default', size = 'default' }: { variant?: ButtonVariant; size?: ButtonSize } = {}) =>
	cn(base, variants[variant], sizes[size]);
