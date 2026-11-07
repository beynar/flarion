/** The chrome's button names, mapped onto entasis `Button`'s `variant` and `size`. */
export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost';
export type ButtonSize = 'default' | 'xs' | 'sm' | 'icon' | 'icon-xs' | 'icon-sm';

export const entasisVariant = { default: 'solid', secondary: 'soft', outline: 'outline', ghost: 'ghost' } as const;
export const entasisSize = { default: 'small', xs: 'small', sm: 'small', icon: 'small', 'icon-xs': 'small', 'icon-sm': 'small' } as const;
