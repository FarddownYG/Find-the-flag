import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, getLocale, setLocale, t, tOr } from './index';
import en from './locales/en.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';

afterEach(async () => {
  await setLocale('en');
});

describe('i18n', () => {
  it('translates and interpolates', async () => {
    expect(t('ui.tool.unexpected', { message: 'boom' })).toBe('Unexpected error: boom');
    await setLocale('fr');
    expect(getLocale()).toBe('fr');
    expect(t('ui.tool.unexpected', { message: 'boom' })).toBe('Erreur inattendue : boom');
  });

  it('picks Russian plural forms with Intl.PluralRules', async () => {
    await setLocale('ru');
    expect(t('ui.out.fileCount', { count: 1 })).toBe('1 файл');
    expect(t('ui.out.fileCount', { count: 3 })).toBe('3 файла');
    expect(t('ui.out.fileCount', { count: 5 })).toBe('5 файлов');
    expect(t('ui.out.fileCount', { count: 21 })).toBe('21 файл');
  });

  it('uses the single Chinese form', async () => {
    await setLocale('zh');
    expect(t('ui.out.rows', { count: 1 })).toBe('1 行');
    expect(t('ui.out.rows', { count: 7 })).toBe('7 行');
  });

  it('falls back to English, then to the key itself', async () => {
    await setLocale('hi');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(tOr('tool.nope.name', 'Fallback name')).toBe('Fallback name');
  });

  it('detects a supported browser language', () => {
    expect(['en', 'fr', 'ru', 'zh', 'hi']).toContain(detectLocale());
  });

  it('ships the same shell keys in every locale', () => {
    const shell = (d: Record<string, string>) =>
      new Set(Object.keys(d).map((k) => k.replace(/_(one|few|many|other)$/, '')));
    const base = shell(en);
    for (const d of [fr, ru, zh, hi]) expect(shell(d)).toEqual(base);
  });
});
