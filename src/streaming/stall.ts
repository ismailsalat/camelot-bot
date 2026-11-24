/**
 * Detects a frozen stream. "The position went up" is not enough: a source that stops delivering data still lets the
 * position creep forward (27 s -> 29 s in 30 s in a real log). What matters is how far the video advanced compared
 * with how much real time passed.
 */
export class StallWatch {
  private win:{t:number;pos:number}|null=null;
  constructor(private windowMs=12000,private minRatio=0.35,private settleMs=8000){}
  reset(){this.win=null}
  /** Call on every poll while the worker says "streaming". Returns details when the stream froze. */
  check(position:number,now:number,sinceChangeMs:number):{advanced:number;elapsed:number;healthy:boolean}|null {
    if(!this.win||position<this.win.pos-1||sinceChangeMs<this.settleMs){this.win={t:now,pos:position};return null}
    if(now-this.win.t<this.windowMs)return null;
    const advanced=position-this.win.pos,elapsed=(now-this.win.t)/1000;
    this.win={t:now,pos:position};
    return advanced<elapsed*this.minRatio?{advanced,elapsed,healthy:false}:{advanced,elapsed,healthy:advanced>=elapsed*0.8};
  }
}
