export function buildEspnTabBridge(endpoint: string): string {
  const source = `(function(){
    var endpoint=${JSON.stringify(endpoint)};
    if(window.__fourthDownBridge){clearInterval(window.__fourthDownBridge.timer);delete window.__fourthDownBridge;}
    function clean(value){return String(value||'').replace(/\\s+/g,' ').trim();}
    function playerId(name){return 'dom:'+clean(name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
    function position(value){return value==='D/ST'?'DST':value;}
    function collect(){
      var rendered=document.body.innerText||''; var body=clean(rendered);
      var rounds=Number((body.match(/RND \\d+ OF (\\d+)/i)||[])[1]||16);
      var picksByNumber=new Map();
      var pickPattern=/^(.+?)\\s*\\/\\s*([A-Z]{2,3})\\s+(QB|RB|WR|TE|K|D\\/ST)(?:,\\s*[A-Z]{1,3})?\\s+R(\\d+),\\s*P(\\d+)\\s*-\\s*(.+)$/i;
      document.querySelectorAll('li,div').forEach(function(element){
        var text=clean(element.innerText); if(!text||text.length>220)return;
        var match=text.match(pickPattern); if(!match)return;
        var round=Number(match[4]), pickInRound=Number(match[5]);
        picksByNumber.set(round+':'+pickInRound,{round:round,pickInRound:pickInRound,playerName:clean(match[1]),team:match[2].toUpperCase(),position:position(match[3].toUpperCase()),draftingTeam:clean(match[6])});
      });
      var rawPicks=Array.from(picksByNumber.values());
      if(rawPicks.length===0)return null;
      var teamCount=rawPicks.reduce(function(max,pick){return Math.max(max,pick.pickInRound);},0);
      if(teamCount<2)return null;
      var picks=rawPicks.map(function(pick){
        return {overallPick:(pick.round-1)*teamCount+pick.pickInRound,externalPlayerId:playerId(pick.playerName),playerName:pick.playerName};
      }).sort(function(a,b){return a.overallPick-b.overallPick;});
      var playerMap=new Map();
      document.querySelectorAll('[role=row],tr').forEach(function(row){
        var text=clean(row.innerText); if(!/\\b(?:DRAFT|QUEUE)\\b/.test(text))return;
        var teamPosition=text.match(/\\b([A-Z]{2,3})\\s+(QB|RB|WR|TE|K|D\\/ST)\\s+(?:DRAFT|QUEUE)\\b/); if(!teamPosition)return;
        var anchors=Array.from(row.querySelectorAll('a')).map(function(a){return clean(a.textContent);});
        var name=anchors.find(function(value){return value&&value.length>2&&!/^news about/i.test(value);}); if(!name)return;
        var rankMatch=text.match(/^(\\d+)\\s/); var projectionMatch=text.match(/\\b(?:DRAFT|QUEUE)\\s+\\d+\\s+([\\d.]+)/);
        var rank=rankMatch?Number(rankMatch[1]):null; var projection=projectionMatch?Number(projectionMatch[1]):null;
        playerMap.set(playerId(name),{externalPlayerId:playerId(name),playerName:name,position:position(teamPosition[2].toUpperCase()),team:teamPosition[1].toUpperCase(),adp:rank,projection:projection,overallRank:rank,positionalRank:rank});
      });
      rawPicks.forEach(function(pick){
        if(!playerMap.has(playerId(pick.playerName)))playerMap.set(playerId(pick.playerName),{externalPlayerId:playerId(pick.playerName),playerName:pick.playerName,position:pick.position,team:pick.team,adp:null,projection:null,overallRank:null,positionalRank:null});
      });
      var draftingTeams=Array.from(new Set(rawPicks.map(function(pick){return pick.draftingTeam;})));
      var lowerBody=body.toLowerCase();
      var scheduledUserTeam=draftingTeams.map(function(team){var count=0,cursor=0,needle=team.toLowerCase();while((cursor=lowerBody.indexOf(needle,cursor))>=0){var prefix=lowerBody.slice(Math.max(0,cursor-28),cursor);if(/pick\\s+\\d+\\s+$/.test(prefix))count+=1;cursor+=needle.length;}return {team:team,count:count};}).sort(function(a,b){return b.count-a.count;}).find(function(candidate){return candidate.count>=2;});
      var rosterLabels=Array.from(document.querySelectorAll('button,[role=button],[role=option],option,h1,h2,h3,h4')).flatMap(function(element){
        return [element.innerText,element.textContent,element.getAttribute('aria-label'),element.getAttribute('title'),element.getAttribute('value')].flatMap(function(value){return String(value||'').split(/\\n+/).map(clean);});
      });
      var rosterLine=clean((rendered.match(/(?:^|\\n)Roster\\s*\\n+([^\\n]+)/i)||[])[1]);
      var completionLabels=body.toUpperCase().includes('YOUR DRAFT IS COMPLETE')?rosterLabels.slice().reverse().concat([rosterLine]):[];
      var rosterName=(scheduledUserTeam&&scheduledUserTeam.team)||completionLabels.find(function(label){return label&&draftingTeams.some(function(team){return team.toLowerCase()===label.toLowerCase();});});
      var ownPick=rawPicks.find(function(pick){return rosterName&&pick.draftingTeam.toLowerCase()===rosterName.toLowerCase();});
      var userSlot=ownPick?((ownPick.round%2)?ownPick.pickInRound:teamCount-ownPick.pickInRound+1):null;
      var externalDraftId=new URL(location.href).searchParams.get('leagueId')||location.pathname;
      return {externalDraftId:externalDraftId,teamCount:teamCount,rounds:rounds,userSlot:userSlot,observedAt:new Date().toISOString(),picks:picks,players:Array.from(playerMap.values())};
    }
    async function tick(){try{var snapshot=collect();if(!snapshot)return;await fetch(endpoint,{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:JSON.stringify(snapshot)});}catch(error){console.warn('Fourth Down bridge',error);}}
    window.__fourthDownBridge={endpoint:endpoint,tick:tick,timer:setInterval(tick,2000)};tick();
  })()`;
  return `javascript:${source.replace(/\s+/g, ' ')}`;
}
