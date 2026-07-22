import { Injectable, OnModuleInit } from '@nestjs/common';
import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Template = Handlebars.TemplateDelegate<Record<string, unknown>>;

@Injectable()
export class AdminRendererService implements OnModuleInit {
  private readonly templates = new Map<string, Template>();

  onModuleInit(): void {
    Handlebars.registerHelper('number', (value: number | undefined) => new Intl.NumberFormat('en-US').format(value ?? 0));
    Handlebars.registerHelper('bytes', (value: number | undefined) => {
      const bytes = value ?? 0;
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
      return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    });
    Handlebars.registerHelper('date', (value: string | undefined) =>
      value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(value)) : '—',
    );
    Handlebars.registerHelper('duration', (value: number | undefined) => `${Math.round(value ?? 0)} ms`);
    Handlebars.registerHelper('short', (value: string | undefined) => (value ? `${value.slice(0, 10)}…` : '—'));
    Handlebars.registerHelper('eq', (left: unknown, right: unknown) => left === right);
  }

  render(page: string, data: Record<string, unknown>): string {
    const content = this.template(page)(data);
    return this.template('layout')({ ...data, content });
  }

  renderLogin(data: Record<string, unknown>): string {
    return this.template('login')(data);
  }

  private template(name: string): Template {
    const cached = this.templates.get(name);
    if (cached) return cached;
    const source = readFileSync(join(__dirname, 'views', `${name}.hbs`), 'utf8');
    const compiled = Handlebars.compile<Record<string, unknown>>(source);
    this.templates.set(name, compiled);
    return compiled;
  }
}
