import { createContext, useContext } from 'react';

export interface PresentationView {
  kind: 'monitor' | 'agent'; enabled: boolean; configured: boolean;
  layout: 'cards' | 'list'; density: 'compact' | 'normal' | 'comfortable';
  columns: number; width: number; accent: string; locale: string;
  colorMode: 'system' | 'light' | 'dark';
  showHistory: boolean; showLatency: boolean; showAvailability: boolean; showExpiry: boolean; showCountry: boolean;
}
export const PresentationViewContext = createContext<PresentationView | null>(null);
export const usePresentationView = () => useContext(PresentationViewContext);
