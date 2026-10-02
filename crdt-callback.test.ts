import * as Y from 'yjs';
import { CRDTCallbackHandler } from './crdt-callback';

describe('CRDTCallbackHandler', () => {
    test('chain history replicates to a second doc (no subdoc loss)', async () => {
        const doc = new Y.Doc();
        const h = new CRDTCallbackHandler({ doc, agentId: 'a1' });
        await h.onChainStart({}, { q: 'hello' });

        const doc2 = new Y.Doc();
        Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
        const agentMap = doc2.getMap('agents').get('a1') as Y.Map<any>;
        const history = agentMap.get('history') as Y.Map<any>;
        expect(history.size).toBe(1);
    });

    test('circular input is recorded via the safe path, not dropped', async () => {
        const doc = new Y.Doc();
        const h = new CRDTCallbackHandler({ doc, agentId: 'a1' });
        const circ: any = { x: 1 };
        circ.self = circ;
        await h.onChainStart({}, circ);
        const entries = h.getHistory();
        expect(entries.length).toBe(1);
        // Circular refs are marked, not silently dropped or crashed on.
        expect((entries[0].entry as any).data).toContain('Circular Reference');
    });

    test('oversize input is truncated to maxEntrySize', async () => {
        const doc = new Y.Doc();
        const h = new CRDTCallbackHandler({ doc, agentId: 'a1', maxEntrySize: 100 });
        await h.onChainStart({}, { big: 'x'.repeat(1000) });
        const entry = h.getHistory()[0].entry as any;
        expect(entry.wasTruncated).toBe(true);
        expect(entry.data.length).toBeLessThanOrEqual(100 + '...[truncated]'.length);
    });

    test('retention policy caps stored entries', async () => {
        const doc = new Y.Doc();
        const h = new CRDTCallbackHandler({ doc, agentId: 'a1', maxHistoryEntries: 5 });
        for (let i = 0; i < 10; i++) {
            await h.onChainStart({}, { i });
        }
        expect(h.getStats().totalEntries).toBe(5);
        expect(h.getStats().operationCount).toBe(10);
    });

    test('pathPrefix config selects the root map', async () => {
        const doc = new Y.Doc();
        const h = new CRDTCallbackHandler({ doc, agentId: 'a1', pathPrefix: 'custom' });
        await h.onChainStart({}, { q: 1 });
        expect(doc.getMap('custom').has('a1')).toBe(true);
        expect(doc.getMap('agents').has('a1')).toBe(false);
        expect(h.getHistory().length).toBe(1);
    });
});
