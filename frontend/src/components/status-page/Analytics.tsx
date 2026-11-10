import { useEffect } from 'react';
import { z } from 'zod';

const analyticsIdSchema = z
  .string()
  .trim()
  .max(32)
  .refine(value => /^(G-[A-Z0-9]+|UA-\d+-\d+|AW-\d+|DC-\d+)$/i.test(value), {
    message: 'Invalid Google Analytics ID format',
  });

interface AnalyticsProps {
  id: string;
}

export default function Analytics({ id }: AnalyticsProps) {
  useEffect(() => {
    if (!id) return;
    const parsedId = analyticsIdSchema.safeParse(id);
    if (!parsedId.success) {
      if (import.meta.env.DEV) console.warn('Skip Google Analytics injection due to invalid ID format');
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(parsedId.data)}`;
    const config = document.createElement('script');
    config.id = 'google-analytics';
    config.text = `
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', ${JSON.stringify(parsedId.data)});
    `;
    document.head.append(script, config);
    return () => {
      script.remove();
      config.remove();
    };
  }, [id]);

  return null;
}
