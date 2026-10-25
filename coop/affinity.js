import {fail,integer,text} from './model.js';
import {hasEvidence} from './body.js';
export function validateAffinityProposal(proposal,profile,source,snapshot) {
    if(!profile || profile.mode==='off') fail('NOT_MANAGED');
    if(!snapshot || snapshot.policyRevision!==profile.policyRevision) fail('STALE_POLICY');
    const delta=integer(proposal.delta,-10,5);
    const reason=text(proposal.reason,300);
    if(delta && (!reason || !hasEvidence(source.body,text(proposal.evidence)) ||
        !hasEvidence(source.userBody,text(proposal.userEvidence)))) fail('INVALID_EVIDENCE');
    return {characterId:profile.id,delta,reason,lockedAtSource:!!snapshot.locked,
        thresholds:snapshot.thresholds,interactionId:source.userId,source};
}
