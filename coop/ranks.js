export const RANK_COUNTS=Object.freeze([4,7,10]);
export const RANK_POLICIES=Object.freeze(Object.fromEntries([
    [4,[30,60,90,100],3],
    [7,[15,30,45,60,75,90,100],6],
    [10,[10,20,30,40,50,60,70,80,90,100],9]
].map(([rankCount,thresholds,relationshipRank])=>[rankCount,Object.freeze({rankCount,
    thresholds:Object.freeze(thresholds),relationshipRank})])));
