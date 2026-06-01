// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

import { AvatarMenu } from '../../src/components/AvatarMenu';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig, ProviderModelOption } from '../../src/types';

const agents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '1.0.0',
    models: [
      { id: 'gpt-5.4', label: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
      { id: 'glm-5', label: 'glm-5' },
      { id: 'qwen3-235b', label: 'qwen3-235b' },
    ],
  },
];

const daemonConfig: AppConfig = {
  mode: 'daemon',
  apiProtocol: 'openai',
  apiKey: '',
  baseUrl: '',
  apiVersion: '',
  model: '',
  byokImageModel: '',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  agentModels: { codex: { model: 'gpt-5.4' } },
};


const byokConfig: AppConfig = {
  ...daemonConfig,
  mode: 'api',
  apiProtocol: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
};

const byokModelsCache: Record<string, ProviderModelOption[]> = {
  ['openai\nhttps://api.openai.com/v1\nsk-test\n']: [
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'gpt-image-2', label: 'gpt-image-2' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
    { id: 'glm-5', label: 'glm-5' },
  ],
};

describe('AvatarMenu', () => {

  it('lets project detail BYOK mode search and switch models from the shared provider catalog', async () => {
    const onApiModelChange = vi.fn();
    render(
      <I18nProvider>
        <AvatarMenu
          config={byokConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={onApiModelChange}
          onOpenSettings={vi.fn()}
          onRefreshAgents={vi.fn()}
          providerModelsCache={byokModelsCache}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    expect(modelCombobox.textContent?.trim()).toBe('gpt-5.5');

    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-byok-model-popover');
    const search = within(popover).getByTestId('avatar-byok-model-search');
    fireEvent.change(search, { target: { value: 'image' } });

    fireEvent.click(within(popover).getByRole('option', { name: 'gpt-image-2' }));
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-image-2');
  });

  it('uses a searchable model dropdown for the active Local CLI model picker', async () => {
    render(
      <I18nProvider>
        <AvatarMenu
          config={daemonConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          providerModelsCache={{}}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    expect(modelCombobox.className).toContain('inline-switcher__select');

    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-model-popover');
    const search = within(popover).getByTestId('avatar-model-search');
    fireEvent.change(search, { target: { value: 'deepseek' } });

    expect(within(popover).getByRole('option', { name: 'deepseek-v4-flash' })).toBeTruthy();
    expect(within(popover).queryByRole('option', { name: 'gpt-5.4-mini' })).toBeNull();
  });
});
