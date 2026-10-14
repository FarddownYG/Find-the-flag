import '@fontsource-variable/martian-mono/standard.css';
// Fallbacks for scripts Martian Mono lacks. unicode-range means a browser only downloads the
// subsets a page actually uses (Chinese and Devanagari text), nothing for Latin/Cyrillic pages.
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-sans-devanagari';
import './ui/styles.css';
import { detectLocale, setLocale } from './i18n';
import { mountApp } from './ui/app';

void setLocale(detectLocale()).finally(() => mountApp(document.getElementById('app')!));
