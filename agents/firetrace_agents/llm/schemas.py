"""What each agent of the LLM commander answers: ids it was given and the reason, nothing else.

Every field is required (the structured-output mode of the OpenAI models is strict: no optional fields), and every free-text field is a reason in Portuguese
that goes into the plan for the operator to read. The agents never write coordinates, action JSON or ids of their own: ``advisor.py`` checks every id they name
against the options they were shown.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class UnitSector(BaseModel):
    unit_id: str = Field(description="id de uma unidade da lista 'units'")
    sector_id: str = Field(description="id de um setor da lista 'sectors', por exemplo S2")
    reason: str = Field(description="porquê esta unidade neste setor, numa frase")


class BombeirosDecision(BaseModel):
    reasoning: str = Field(description="leitura da frente do fogo e do terreno, em 2 a 4 frases")
    assignments: list[UnitSector] = Field(description="SÓ as unidades que mudas de setor em relação a 'rulesAssignment'; as que não indicares ficam como estão")


class EvacuationOrder(BaseModel):
    reasoning: str = Field(description="critério da ordem, em 2 a 3 frases")
    order: list[str] = Field(description="TODOS os ids de 'places', do primeiro a evacuar para o último, cada um uma só vez")


class ShelterPick(BaseModel):
    place_id: str = Field(description="o 'placeId' da evacuação")
    shelter_id: str = Field(description="o id de uma das 'options' dessa evacuação")
    reason: str = Field(description="porquê este abrigo, numa frase")


class ShelterChoice(BaseModel):
    reasoning: str = Field(description="critério da escolha, em 1 a 3 frases")
    picks: list[ShelterPick] = Field(description="só as evacuações em que escolhes um abrigo diferente do primeiro da lista; as outras ficam como estão")


class ClosureDecision(BaseModel):
    reasoning: str = Field(description="critério, em 2 a 3 frases: que estradas protegem as pessoas e o acesso dos bombeiros")
    enforce: list[str] = Field(description="ids de 'closures' a impor, do mais prioritário para o menos; os que não indicares não são impostos")


class StandbyDecision(BaseModel):
    reasoning: str = Field(description="critério, em 1 a 3 frases")
    back_m: float = Field(description="UMA das distâncias de 'safeDistancesBehindCrewsM'")
    ambulances: int = Field(description="quantas ambulâncias ficam de prevenção, entre 1 e 'ambulancesAvailable'")


class ReviewNote(BaseModel):
    note: str = Field(description="nota do comandante ao operador, até 90 palavras: o que o plano faz e o que merece confirmação")
    concerns: list[str] = Field(description="até 4 pontos a confirmar no terreno, cada um numa frase curta")
