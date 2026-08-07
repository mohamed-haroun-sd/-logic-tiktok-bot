const fs = require("fs");
const CONFIG = require("../config");

function loadCards(){
    try{
        return JSON.parse(fs.readFileSync(CONFIG.CARD_FILE,"utf8"));
    }catch(e){
        return [];
    }
}

let cards=loadCards();
let current=0;

function currentCard(){
    if(cards.length===0) return null;
    return cards[current];
}

function nextCard(){
    if(cards.length===0) return null;
    current++;
    if(current>=cards.length) current=0;
    console.log("💳 Switch Card ->",current+1);
    return cards[current];
}

function reload(){
    cards=loadCards();
    current=0;
}

module.exports={
    currentCard,
    nextCard,
    reload
};
