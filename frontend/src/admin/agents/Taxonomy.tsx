import { Modal, Select } from '@/components/ui/MotionOverlays';
﻿import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, Input, ModalBody, ModalContent, ModalFooter, ModalHeader, SelectItem } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { taxonomyApi, type AgentGroup, type AgentTag } from './api';
import { usePresentation } from '../settings/presentation-api';

export function useAgentTaxonomy() {
  const presentation=usePresentation();
  const enabled=presentation.data?.config.agentEnabled===true;
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [tags, setTags] = useState<AgentTag[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      if (enabled) {
        const [groupResult, tagResult] = await Promise.all([taxonomyApi.groups(), taxonomyApi.tags()]);
        setGroups(groupResult.groups);
        setTags(tagResult.tags);
      } else {setGroups([]);setTags([]);}
      setError(null);
    } catch (reason) { setError(reason); }
  }, [enabled]);
  useEffect(() => { void load(); }, [load]);
  return { enabled, groups, tags, error: error ?? presentation.error, load };
}

export function TaxonomyFields({ groups, tags, groupId, tagIds, onGroupChange, onTagsChange, disabled }: {
  groups: AgentGroup[]; tags: AgentTag[]; groupId: string | null; tagIds: string[];
  onGroupChange: (id: string | null) => void; onTagsChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const t = useTranslations('admin.agentTaxonomy');
  return <div className="flex flex-col gap-3">
    <Select label={t('group')} placeholder={t('ungrouped')} selectedKeys={groupId ? [groupId] : []} onSelectionChange={keys => onGroupChange([...keys][0] ? String([...keys][0]) : null)} isDisabled={disabled}>
      {groups.map(group => <SelectItem key={group.id} textValue={group.name}>{group.name}</SelectItem>)}
    </Select>
    <Select label={t('tags')} selectionMode="multiple" selectedKeys={tagIds} onSelectionChange={keys => onTagsChange(keys === 'all' ? tags.map(tag => tag.id) : [...keys].map(String))} isDisabled={disabled}>
      {tags.map(tag => <SelectItem key={tag.id} textValue={tag.name}>{tag.name}</SelectItem>)}
    </Select>
  </div>;
}

export function TaxonomyEditor({ kind, item, onClose, onSaved }: {
  kind: 'groups' | 'tags'; item: AgentGroup | AgentTag | null; onClose: () => void; onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.agentTaxonomy');
  const a = useTranslations('admin.action');
  const message = useApiErrorMessage();
  const [name, setName] = useState(item?.name ?? '');
  const [extra, setExtra] = useState(kind === 'groups' ? String((item as AgentGroup | null)?.weight ?? 0) : (item as AgentTag | null)?.color ?? '#6366F1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      await taxonomyApi.save(kind, item?.id ?? null, kind === 'groups' ? { name: name.trim(), weight: Number(extra) } : { name: name.trim(), color: extra });
      await onSaved(); onClose();
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  return <Modal isOpen onClose={() => !busy && onClose()}><ModalContent>
    <ModalHeader>{t(item ? 'edit' : 'create')} · {t(kind === 'groups' ? 'agentGroup' : 'agentTag')}</ModalHeader>
    <ModalBody>
      <Input label={t('name')} value={name} onValueChange={setName} maxLength={100} isRequired />
      <Input label={t(kind === 'groups' ? 'weight' : 'color')} value={extra} onValueChange={setExtra} type={kind === 'groups' ? 'number' : 'color'} />
      {error ? <p role="alert" className="text-small text-danger">{error}</p> : null}
    </ModalBody><ModalFooter><Button variant="light" onPress={onClose} isDisabled={busy}>{a('cancel')}</Button><Button color="primary" onPress={() => void save()} isLoading={busy} isDisabled={!name.trim() || (kind === 'groups' && (!Number.isInteger(Number(extra)) || Math.abs(Number(extra)) > 100000))}>{a('save')}</Button></ModalFooter>
  </ModalContent></Modal>;
}

export function TaxonomyDelete({ kind, item, onClose, onDeleted }: {
  kind: 'groups' | 'tags'; item: AgentGroup | AgentTag; onClose: () => void; onDeleted: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.agentTaxonomy'); const a = useTranslations('admin.action'); const message = useApiErrorMessage();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function remove() { setBusy(true); setError(''); try { await taxonomyApi.remove(kind, item.id); await onDeleted(); onClose(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal isOpen onClose={() => !busy && onClose()}><ModalContent><ModalHeader>{a('delete')} · {t(kind === 'groups' ? 'agentGroup' : 'agentTag')}</ModalHeader><ModalBody><p>{item.name}</p><p className="text-small text-default-500">{t(kind === 'groups' ? 'deleteGroupHint' : 'deleteTagHint')}</p>{error ? <p role="alert" className="text-danger">{error}</p> : null}</ModalBody><ModalFooter><Button variant="light" onPress={onClose} isDisabled={busy}>{a('cancel')}</Button><Button color="danger" onPress={() => void remove()} isLoading={busy}>{a('delete')}</Button></ModalFooter></ModalContent></Modal>;
}
