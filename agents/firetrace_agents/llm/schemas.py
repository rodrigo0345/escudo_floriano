"""What each agent of the LLM commander answers: ids it was given and the reason, nothing else.

Every field is required (the structured-output mode of the OpenAI models is strict: no optional fields). Free-text reasons are written in European Portuguese,
because the operator reads them in the plan. The agents never write coordinates, action JSON or ids of their own: ``advisor.py`` checks every id they name
against the options they were shown.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class UnitSector(BaseModel):
    unit_id: str = Field(description="id of a unit in 'units'")
    sector_id: str = Field(description="id of a sector in 'sectors', e.g. S2")
    reason: str = Field(description="why this unit goes to this sector, one sentence in pt-PT")


class BombeirosDecision(BaseModel):
    reasoning: str = Field(description="reading of the fire front and terrain, 2 to 4 sentences in pt-PT")
    assignments: list[UnitSector] = Field(description="ONLY units that change sector compared with 'rulesAssignment'; units you leave out stay as they are")


class EvacuationOrder(BaseModel):
    reasoning: str = Field(description="criterion for the order, 2 to 3 sentences in pt-PT")
    order: list[str] = Field(description="ALL ids in 'places', from the first to evacuate to the last, each exactly once")


class ShelterPick(BaseModel):
    place_id: str = Field(description="the 'placeId' of the evacuation")
    shelter_id: str = Field(description="an id from that evacuation's 'options'")
    reason: str = Field(description="why this shelter, one sentence in pt-PT")


class ShelterChoice(BaseModel):
    reasoning: str = Field(description="criterion for the choice, 1 to 3 sentences in pt-PT")
    picks: list[ShelterPick] = Field(description="only evacuations where you choose a shelter other than the first in the list; the others stay as they are")


class ClosureDecision(BaseModel):
    reasoning: str = Field(description="criterion, 2 to 3 sentences in pt-PT: which roads protect people and firefighter access")
    enforce: list[str] = Field(description="ids in 'closures' to enforce, most urgent first; those you leave out go last in the queue but stay closed (the ring does not open)")


class StandbyDecision(BaseModel):
    reasoning: str = Field(description="criterion, 1 to 3 sentences in pt-PT")
    back_m: float = Field(description="ONE of the distances in 'safeDistancesBehindCrewsM'")
    ambulances: int = Field(description="how many ambulances stand by, between 1 and 'ambulancesAvailable'")


class ReviewNote(BaseModel):
    note: str = Field(description="commander's note to the operator, up to 90 words in pt-PT: what the plan does and what needs confirmation")
    concerns: list[str] = Field(description="up to 4 points to confirm on the ground, each one short sentence in pt-PT")
